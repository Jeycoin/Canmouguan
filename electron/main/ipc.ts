import { ipcMain, shell, app, BrowserWindow, dialog } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  getSettings,
  saveSettings,
  patchSettings,
  encryptSecret,
  getUserDataDir,
  getDefaultKnowledgeDir,
  assertSafeKnowledgeDir
} from './store'
import * as win from './window'
import * as hotkeys from './shortcuts'
import * as capture from './capture'
import * as cloud from './cloud'
import { DashScopeRealtime, VadSegmenter, transcribeFile, testDashScope, encodeWav } from './stt'
import { streamChat, chatOnce, testLLM, listModels, clearClientCache } from './llm'
import * as kb from './knowledge'
import * as mem from './memory'
import {
  buildSystemPrompt,
  buildTranscriptPrompt,
  buildScreenshotPrompt,
  buildReviewPrompt,
  renderTemplate,
  buildContext,
  baseVars,
  findUnknownVars,
  historyToMessages
} from './prompt'
import type {
  ChatMessage,
  HotkeySettings,
  KnowledgeHit,
  MemoryItem,
  Settings,
  STTChannel,
  STTChannelConfig
} from '../shared/types'

/* ------------------------------ 工具函数 ------------------------------ */

function broadcast(channel: string, ...args: unknown[]) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send(channel, ...args)
    } catch (err) {
   console.error('[ipc] 忽略异常', err)
      /* 窗口已销毁 */
    }
  }
}

/** 设置下发到渲染层时，Key 一律脱敏 */
function sanitizedSettings(): Settings {
  const s = JSON.parse(JSON.stringify(getSettings())) as Settings
  for (const p of s.llm.profiles) {
    // 只告诉 UI 是否保存过 Key，不再暴露任何 Key 片段（包括长度）
    p.hasKey = !!p.apiKeyEnc
    delete p.apiKeyEnc
  }
  s.stt.hasKey = !!s.stt.apiKeyEnc
  delete s.stt.apiKeyEnc
  // 云端 token 同理：只告诉 UI "已登录"，token 本身永远不下发
  if (s.cloud) {
    s.cloud.hasToken = !!s.cloud.tokenEnc
    delete s.cloud.tokenEnc
  }
  ;(s as unknown as Record<string, unknown>).paths = {
    userData: getUserDataDir(),
    knowledge: s.knowledgeDir || getDefaultKnowledgeDir()
  }
  return s
}

/**
 * 密钥字段通道隔离：
 * `settings:patch` 一律不允许携带 apiKeyEnc / apiKeyMasked / tokenEnc。
 *
 * 自带 Key 时代，这条防线是为了"渲染层误把脱敏副本回写"；
 * 现在 BYOK 界面已经全删，但**仍然照剥不误** —— 那几个字段还在类型里
 * （标了 `@deprecated`），一旦将来恢复 BYOK，这条防线不该靠"记得补回来"。
 * 登录凭据的写入只能走 `cloud:*`。
 */
function stripSecretFields<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((x) => stripSecretFields(x)) as unknown as T
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  delete out.apiKeyEnc
  delete out.apiKeyMasked
  delete out.tokenEnc
  delete out.hasToken
  for (const k of Object.keys(out)) out[k] = stripSecretFields(out[k])
  return out as T
}

function runWithRetry<T>(fn: () => Promise<T>, retries = 1, delayMs = 600): Promise<T> {
  let lastErr: unknown
  return (async () => {
    for (let i = 0; i <= retries; i++) {
      try {
        return await fn()
      } catch (err) {
        lastErr = err
        if (i < retries) await new Promise((r) => setTimeout(r, delayMs * (i + 1)))
      }
    }
    throw lastErr
  })()
}

/* ------------------------------ STT 会话 ------------------------------ */

/**
 * 单个**采集通道**的转写会话。
 *
 * 之所以是"每通道一份"而不是全局单例：两条链路的处理模式可以不同
 * （面试官 realtime 流式、我自己 file 整段上传），
 * 而 realtime 的 PCM 是随来随走的、file 的 PCM 必须攒着 —— 两者的缓冲生命周期正相反。
 * 共用一个 session 必然互相踩（这也正是改造前 `sttSession` 单例的根本问题）。
 */
interface STTSession {
  channel: STTChannel
  realtime?: DashScopeRealtime | null
  vad?: VadSegmenter
  pcmChunks: Buffer[]
  pcmBytes: number
  startedAt: number
  liveText: string
  segments: string[]
}

const sttSessions = new Map<STTChannel, STTSession>()

/**
 * 离线模式（停止后整段上传）下 PCM 会一直堆在内存里：16kHz×16bit = 32KB/s。
 * 设一个 20 分钟的上限（约 38MB），超出后丢掉最早的一半，宁可丢开头也不让进程 OOM。
 * 现在是**每通道**各自一份上限，两个通道最多占用约 76MB。
 */
const MAX_STT_BUFFER_BYTES = 20 * 60 * 16000 * 2

function getSession(channel: STTChannel): STTSession | undefined {
  return sttSessions.get(channel)
}

function ensureSession(channel: STTChannel): STTSession {
  let s = sttSessions.get(channel)
  if (!s) {
    s = { channel, pcmChunks: [], pcmBytes: 0, startedAt: Date.now(), liveText: '', segments: [] }
    sttSessions.set(channel, s)
  }
  return s
}

/** 该通道当前生效的模型名：realtime 与 file 可以不同（流式模型和离线模型本就分开选） */
/**
 * 该通道该用哪个模型。
 *
 * 最后一步一定要过 `cloud.clampModel`：网关会把非白名单模型**静默改写**成它自己的默认值，
 * 不夹的话客户端以为在用 A、服务端跑的是 B，而且不报错 —— 是最难查的一类问题。
 * 顺便它还负责"实时/离线不能混用模型"这条。
 */
function modelForChannel(cfg: STTChannelConfig, mode: 'realtime' | 'file', fallback: string): string {
  const m = mode === 'realtime' ? cfg.realtimeModel : cfg.fileModel
  return cloud.clampModel('asr', m?.trim() || fallback, mode)
}

/**
 * 启动一个通道的转写。
 *
 * `mode` 来自**该通道自己的配置**，不再读全局 `stt.mode` ——
 * 这是双通道的关键：面试官那路要低延迟，我自己那路要准确率，两者必须能各走各的。
 */
async function startChannel(channel: STTChannel) {
  const s = getSettings()
  const cfg = s.stt.channels[channel]
  if (!cfg?.enabled) return

  // 落点解析：恒为网关。未登录/网关不可达会在这里抛出可读错误。
  const conn = cloud.asrConn()

  const session = ensureSession(channel)
  session.pcmChunks = []
  session.pcmBytes = 0
  session.liveText = ''
  session.segments = []
  session.startedAt = Date.now()

  broadcast('stt:state', { channel, state: 'connecting' })

  // VAD 分段：实时模式下用于自动断句并可选自动发送
  session.vad = new VadSegmenter({
    sampleRate: s.stt.sampleRate,
    threshold: s.stt.vadThreshold,
    silenceMs: s.stt.vadSilenceMs,
    onSegment: () => {
      /* 实时模式下服务端已断句，这里只做静音过滤占位 */
    }
  })

  if (cfg.mode === 'realtime') {
    // 防重复启动：IPC 通道可以被直接调用，主进程这边也要有守卫。
    // 否则旧的 WebSocket 会一直挂着继续推流 → 服务端重复转写 + socket 泄漏。
    if (session.realtime) {
      try {
        session.realtime.abort()
      } catch (err) {
        console.error(`[stt:${channel}] 关闭旧 realtime 失败`, err)
      }
      session.realtime = null
    }
    const model = modelForChannel(cfg, 'realtime', s.stt.model)
    const rt = new DashScopeRealtime(conn, { ...s.stt, model })
    rt.on('partial', (text: string, sentenceEnd: boolean) => {
      broadcast('stt:partial', { channel, text, stable: sentenceEnd })
    })
    rt.on('segment', (text: string) => {
      session.segments.push(text)
      session.liveText = session.segments.join(' ')
    })
    rt.on('error', (message: string) => {
      broadcast('stt:error', { channel, message })
      broadcast('stt:state', { channel, state: 'error' })
    })
    rt.on('state', (state: string) => broadcast('stt:state', { channel, state }))
    await rt.start(2)
    session.realtime = rt
    broadcast('stt:state', { channel, state: 'listening' })
  } else {
    broadcast('stt:state', { channel, state: 'listening' })
  }
}

/** 关闭并清理一个通道的会话（任何路径都不能漏 WebSocket） */
function teardownChannel(channel: STTChannel) {
  const session = sttSessions.get(channel)
  if (!session) return
  if (session.realtime) {
    try {
      session.realtime.abort()
    } catch (err) {
      console.error(`[stt:${channel}] 兜底关闭 realtime 失败`, err)
    }
    session.realtime = null
  }
  session.pcmChunks = []
  session.pcmBytes = 0
  sttSessions.delete(channel)
}

/** 停止一个通道并拿到最终文本；返回空串表示没有有效内容 */
async function stopChannel(channel: STTChannel): Promise<string> {
  const s = getSettings()
  const cfg = s.stt.channels[channel]
  const session = sttSessions.get(channel)
  if (!cfg || !session) return ''

  broadcast('stt:state', { channel, state: 'processing' })
  let finalText = ''

  try {
    if (cfg.mode === 'realtime' && session.realtime) {
      finalText = await session.realtime.finish()
      session.realtime = null
      if (!finalText && session.segments.length) finalText = session.segments.join(' ')
    } else {
      const pcm = Buffer.concat(session.pcmChunks)
      if (pcm.length < s.stt.sampleRate * 0.3) {
        finalText = ''
      } else {
        const pcm16 = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))
        const wav = encodeWav(pcm16, s.stt.sampleRate)
        const model = modelForChannel(cfg, 'file', s.stt.model)
        // 停止阶段重新解析一次落点：登录状态可能在录音期间变了（token 过期 / 被登出）
        const conn = cloud.asrConn()
        finalText = await runWithRetry(
          () => transcribeFile(conn, { ...s.stt, model }, wav, 2),
          1
        )
      }
    }
  } finally {
    // finally 而不是 try 之后：finish() 抛错时也要把连接和缓冲清干净
    teardownChannel(channel)
  }

  return (finalText || '').trim()
}

/** 当前启用的通道列表（顺序固定：先面试官后自己，UI 展示更稳定） */
function enabledChannels(): STTChannel[] {
  const s = getSettings()
  return (['interviewer', 'candidate'] as STTChannel[]).filter((c) => s.stt.channels[c]?.enabled)
}

/** 启动所有启用通道。部分通道失败不应拖垮另一条 —— 面试中能录到一半也远好过全丢。 */
async function startSTT(): Promise<{ started: STTChannel[]; failed: { channel: STTChannel; message: string }[] }> {
  const channels = enabledChannels()
  if (!channels.length) throw new Error('没有启用任何采集通道（设置 → 语音识别）')

  const started: STTChannel[] = []
  const failed: { channel: STTChannel; message: string }[] = []

  for (const ch of channels) {
    try {
      await startChannel(ch)
      started.push(ch)
    } catch (err) {
      const message = (err as Error).message
      failed.push({ channel: ch, message })
      console.error(`[stt:${ch}] 启动失败`, message)
      teardownChannel(ch)
      broadcast('stt:state', { channel: ch, state: 'error' })
      broadcast('stt:error', { channel: ch, message })
    }
  }

  if (!started.length) {
    throw new Error(failed[0]?.message ?? '转写通道启动失败')
  }
  return { started, failed }
}

/**
 * 停止所有通道。每个通道独立处理与独立落库 ——
 * 这也意味着"我只想整理自己的回答"可以只停 candidate 而不影响面试官的实时转写。
 */
async function stopSTT(channel?: STTChannel): Promise<{ channel: STTChannel; text: string }[]> {
  const s = getSettings()
  const channels = channel ? [channel] : [...sttSessions.keys()]
  const out: { channel: STTChannel; text: string }[] = []

  for (const ch of channels) {
    let text = ''
    try {
      text = await stopChannel(ch)
    } catch (err) {
      broadcast('stt:error', { channel: ch, message: (err as Error).message })
      broadcast('stt:state', { channel: ch, state: 'error' })
      continue
    }

    broadcast('stt:state', { channel: ch, state: 'idle' })

    if (!text) {
      broadcast('stt:final', { channel: ch, text: '', skipped: true, reason: '空文本，未发送' })
      continue
    }

    // 落库时带上说话人角色：通道本身就是最可靠的说话人来源
    mem.addTranscript(text, ch)
    broadcast('stt:final', { channel: ch, text, skipped: false })
    out.push({ channel: ch, text })

    /*
     * 自动发送按**通道各自的** sendMode 决定。
     *
     * 这正是双通道最实用的一点：面试官那路设 auto，问题一落定就直接出答案（实时反馈）；
     * 我自己那路设 edit，转写进输入框供事后整理，不会打断面试官的实时问答。
     * 顺序上让面试官先发（它排在 channels 前面），避免我自己的长回答把问答流冲乱。
     */
    if (s.stt.channels[ch]?.sendMode === 'auto' && ch === 'interviewer') {
      void askFromTranscript(text, [])
    }
  }

  return out
}

/* ------------------------------ LLM 请求 ------------------------------ */

let activeAbort: AbortController | null = null
let llmBusy = false

function runLLMStream(opts: {
  id: string
  system: string
  user: string
  history?: ChatMessage[]
  imageDataUrl?: string
}) {
  // 并发保护：同一时刻只跑一个 LLM 流，避免图片+文字双开导致前端卡顿与供应商限流
  if (llmBusy) {
    console.log('[llm] busy, dropping request', opts.id)
    broadcast('llm:error', { id: opts.id, message: '当前已有请求在生成中，请等待或先停止' })
    return
  }
  if (activeAbort) activeAbort.abort()
  const controller = new AbortController()
  activeAbort = controller
  llmBusy = true

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: opts.system }
  ]
  // 上下文窗口保留最近 4 轮，历史图片不再转发（llm.ts 会进一步 trim）
  if (opts.history?.length) messages.push(...historyToMessages(opts.history, 4))
  messages.push({ role: 'user', content: opts.user })

  broadcast('llm:start', { id: opts.id })
  const startedAt = Date.now()

  streamChat(
    { messages, imageDataUrl: opts.imageDataUrl, signal: controller.signal, maxContextTurns: 4, imageDetail: 'auto' },
    {
      onThinking: () => broadcast('llm:thinking', { id: opts.id }),
      onDelta: (delta) => broadcast('llm:delta', { id: opts.id, delta }),
      onDone: (full) => {
        console.log(`[llm] done id=${opts.id} elapsed=${Date.now() - startedAt}ms`)
        broadcast('llm:done', { id: opts.id, text: full })
        mem.addAiAnswer(full)
        llmBusy = false
        if (activeAbort === controller) activeAbort = null
      },
      onError: (message) => {
        console.log(`[llm] error id=${opts.id} elapsed=${Date.now() - startedAt}ms`, message)
        broadcast('llm:error', { id: opts.id, message })
        llmBusy = false
        if (activeAbort === controller) activeAbort = null
      }
    }
  )
}

async function askFromTranscript(text: string, history: ChatMessage[]): Promise<string> {
  const id = randomUUID()
  const { system, user } = buildTranscriptPrompt(text)
  runLLMStream({ id, system, user, history })
  return id
}

/* -------------------------------- 复盘 -------------------------------- */

interface ReviewDraft {
  question?: string
  knowledgePoints?: string[]
  referenceAnswer?: string
  myAnswer?: string
  weakPoints?: string[]
  suggestions?: string
  tags?: string[]
  mastery?: number
}

function parseReviewJSON(raw: string): ReviewDraft[] {
  const cleaned = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('模型未返回 JSON 数组')
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as ReviewDraft[]
  if (!Array.isArray(parsed)) throw new Error('复盘结果格式不正确')
  return parsed
}

async function runReview(sessionId: string): Promise<MemoryItem[]> {
  const session = mem.listSessions().find((s) => s.id === sessionId) ?? mem.getSession(sessionId)
  if (!session) throw new Error('未找到该面试会话')
  const s = getSettings()
  if (!s.memory.enabled) throw new Error('记忆库已关闭，无法复盘')

  const material = mem.sessionMaterial(session)
  const { system, user } = buildReviewPrompt(material)
  broadcast('review:start', { sessionId })

  const raw = await runWithRetry(() => chatOnce({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens: 4096 }), 1)
  const drafts = parseReviewJSON(raw)

  const created: MemoryItem[] = []
  for (const d of drafts.slice(0, 20)) {
    if (!d?.question) continue
    if (s.memory.excludeSensitive && /薪资|工资|加班|996|裁员|离职原因.*钱/i.test(d.question)) continue
    created.push(
      mem.addMemory({
        question: String(d.question),
        knowledgePoints: Array.isArray(d.knowledgePoints) ? d.knowledgePoints.map(String) : [],
        referenceAnswer: String(d.referenceAnswer ?? ''),
        myAnswer: String(d.myAnswer ?? ''),
        weakPoints: Array.isArray(d.weakPoints) ? d.weakPoints.map(String) : [],
        suggestions: String(d.suggestions ?? ''),
        tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
        mastery: d.mastery as MemoryItem['mastery'],
        source: {
          company: session.company,
          role: session.role,
          round: session.round,
          at: session.endedAt ?? Date.now(),
          sessionId: session.id
        }
      })
    )
  }

  broadcast('review:done', {
    sessionId,
    created: created.length,
    items: created.map((c) => ({ id: c.id, question: c.question, mastery: c.mastery }))
  })
  return created
}

/* ------------------------------ IPC 注册 ------------------------------ */

export function registerIPC() {
  /* -------- 设置 -------- */
  ipcMain.handle('settings:get', () => sanitizedSettings())

  ipcMain.handle('settings:patch', (_e: IpcMainInvokeEvent, patch: Partial<Settings>) => {
    const safePatch = stripSecretFields(patch)
    // knowledgeDir 会触发 mkdir + 写示例文档，必须先做路径白名单校验
    if (safePatch.knowledgeDir !== undefined) {
      assertSafeKnowledgeDir(safePatch.knowledgeDir)
    }
    patchSettings(safePatch)
    broadcast('settings:changed', sanitizedSettings())
    // 窗口相关的设置（任务栏显示 / 共享时隐藏）不会自动落到原生窗口上，
    // 必须显式重应用一次，否则要重启才生效。
    if (safePatch.window) win.applyWindowSettings()
    // 切换云端/本地模式会换掉 baseURL 与凭据，复用中的 SDK 实例必须丢弃
    // （指纹里带 baseURL，理论上会自动 miss，但显式清一次更不容易被后续改动破坏）
    if (safePatch.cloud) clearClientCache()
    // 知识库目录变更时重新加载
    if (safePatch.knowledgeDir) {
      kb.loadKnowledge(safePatch.knowledgeDir)
      kb.watchKnowledge(safePatch.knowledgeDir)
    }
    return sanitizedSettings()
  })

  /** 用系统目录选择框挑知识库目录，避免用户手敲路径踩到禁止目录 */
  ipcMain.handle('kb:pickDir', async () => {
    const current = getSettings().knowledgeDir || getDefaultKnowledgeDir()
    const res = await dialog.showOpenDialog({
      title: '选择知识库目录',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory', 'noResolveAliases']
    })
    if (res.canceled || !res.filePaths.length) return null
    const dir = res.filePaths[0]
    try {
      assertSafeKnowledgeDir(dir)
    } catch (err) {
      return { error: (err as Error).message }
    }
    kb.loadKnowledge(dir)
    kb.watchKnowledge(dir)
    patchSettings({ knowledgeDir: dir })
    broadcast('settings:changed', sanitizedSettings())
    return { dir }
  })

  /**
   * ⚠️ **已废弃：界面上没有任何入口会调用它，主进程也不再读取这些字段。**
   *
   * 之所以留着而不是删掉：一旦将来要恢复"自带 Key"，只需恢复界面，
   * 不用再把这条写密钥的通道（连同 `safeStorage` 的加解密与脱敏规则）重新搭一遍。
   * 它写入的 `apiKeyEnc` 现在**完全不起作用** —— 落点恒为网关，见 `cloud.ts`。
   */
  ipcMain.handle('settings:setSecret', (_e, arg: { scope: 'llm' | 'stt'; profileId?: string; value: string }) => {
    const s = getSettings()
    const value = arg.value ?? ''
    if (arg.scope === 'stt') {
      // 空字符串 = 用户主动清除
      s.stt.apiKeyEnc = value ? encryptSecret(value) : undefined
    } else {
      const p = s.llm.profiles.find((x) => x.id === arg.profileId) ?? s.llm.profiles[0]
      if (!p) throw new Error('未找到供应商配置')
      p.apiKeyEnc = value ? encryptSecret(value) : undefined
    }
    saveSettings(s)
    broadcast('settings:changed', sanitizedSettings())
    return { ok: true }
  })

  /** @deprecated 同 `settings:setSecret`：保留通道，界面上已无入口。 */
  ipcMain.handle('settings:clearSecret', (_e, arg: { scope: 'llm' | 'stt'; profileId?: string }) => {
    const s = getSettings()
    if (arg.scope === 'stt') {
      s.stt.apiKeyEnc = undefined
    } else {
      const p = s.llm.profiles.find((x) => x.id === arg.profileId) ?? s.llm.profiles[0]
      if (!p) throw new Error('未找到供应商配置')
      p.apiKeyEnc = undefined
    }
    saveSettings(s)
    broadcast('settings:changed', sanitizedSettings())
    return { ok: true }
  })

  /* -------- 云端账号 -------- */

  /**
   * 账号相关的 IPC 必须**全部落在主进程**。
   *
   * token 就是这一层的"钱袋子"：一旦它有哪怕一次往返进了渲染层，
   * 就等于交给了任意一段注入进页面的脚本。所以渲染层只提交"账号/手机号 + 密码/验证码"
   * 这类一次性输入，拿回的永远是脱敏快照（`cloudSnapshot`）。
   */
  function cloudSnapshot() {
    const c = getSettings().cloud
    return {
      /** 解析后的实际网关地址（用户没填时是默认值）—— 界面要显示"到底连的是哪" */
      baseURL: cloud.cloudBaseURL(),
      loggedIn: cloud.cloudLoggedIn(),
      me: c?.lastMe ?? null
    }
  }

  /**
   * 登录态/额度变化后统一广播。
   *
   * 只广播 `settings:changed` 就够了 —— 账号与额度快照都在 `settings.cloud` 里，
   * 而渲染层已经订阅了它。为此再开一个专用通道是**多余的**：
   * 那会变成一条"没有任何订阅者"的死通道，下次改动时没人知道该不该维护。
   */
  function broadcastCloud() {
    broadcast('settings:changed', sanitizedSettings())
  }

  /* 凭据失效（token 过期 / 被服务端作废）时 cloud.ts 会调回来，
     广播一次让渲染层立刻回到登录页 —— 否则用户会卡在一个什么都干不了的界面里。 */
  cloud.setSessionLostHandler(broadcastCloud)

  ipcMain.handle('cloud:status', () => cloudSnapshot())

  ipcMain.handle('cloud:ping', () => cloud.pingGateway())

  /**
   * 服务端放行的模型清单。
   * 拉不到时内部回落兜底清单并带 `live: false` —— 界面据此提示
   * "用的是内置清单，可能与服务端不一致"，而不是假装一切正常。
   */
  ipcMain.handle('cloud:models', async () => {
    try {
      return { ok: true, ...(await cloud.loadModelCatalog()) }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  /**
   * 套餐与购买方式。**不需要登录**：用户是先买码、再注册的，
   * 要求先登录才能看到价格等于把最大的那部分人挡在门外。
   */
  ipcMain.handle('cloud:plans', async () => {
    try {
      return { ok: true, ...(await cloud.loadStoreInfo()) }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  ipcMain.handle('cloud:smsSend', async (_e, arg: { phone: string; purpose: 'login' | 'register' }) => {
    try {
      return { ok: true, ...(await cloud.sendSmsCode(arg.phone, arg.purpose)) }
    } catch (err) {
      return { ok: false, message: (err as Error).message, reason: (err as { reason?: string }).reason }
    }
  })

  ipcMain.handle('cloud:login', async (_e, arg: cloud.LoginInput) => {
    try {
      const me = await cloud.login(arg)
      clearClientCache()
      broadcastCloud()
      return { ok: true, me }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  ipcMain.handle('cloud:register', async (_e, arg: cloud.RegisterInput) => {
    try {
      const { me, warning } = await cloud.register(arg)
      clearClientCache()
      broadcastCloud()
      return { ok: true, me, warning }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  ipcMain.handle('cloud:redeem', async (_e, arg: { code: string }) => {
    try {
      const { me, message } = await cloud.redeem(arg.code)
      broadcastCloud()
      return { ok: true, me, message }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  ipcMain.handle('cloud:refresh', async () => {
    try {
      const me = await cloud.refreshMe()
      broadcastCloud()
      return { ok: true, me }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  ipcMain.handle('cloud:logout', () => {
    cloud.logout()
    clearClientCache()
    broadcastCloud()
    return { ok: true }
  })

  /* -------- 窗口 -------- */
  ipcMain.handle('window:action', (_e, arg: { action: string; value?: number | boolean }) => {
    const v = arg.value
    switch (arg.action) {
      case 'show':
        win.showWindow()
        break
      case 'hide':
        win.hideWindow()
        break
      case 'toggle':
        win.toggleWindow()
        break
      case 'clickThrough':
        win.applyClickThrough(Boolean(v))
        break
      case 'toggleClickThrough':
        return win.toggleClickThrough()
      case 'alwaysOnTop':
        win.applyAlwaysOnTop(Boolean(v))
        break
      case 'toggleAlwaysOnTop':
        return win.toggleAlwaysOnTop()
      case 'opacity':
        win.setOpacity(Number(v))
        break
      case 'collapse':
        win.setCollapsed(Boolean(v))
        break
      case 'toggleCollapse':
        return win.toggleCollapsed()
      case 'stealth':
        win.setStealth(Boolean(v))
        break
      case 'moveToCursor':
        win.moveToCursorDisplay()
        break
      case 'taskbar':
        win.setTaskbarVisible(Boolean(v))
        break
      case 'quit':
        app.quit()
        break
      default:
        break
    }
    return true
  })

  ipcMain.handle('window:state', () => ({
    clickThrough: win.isClickThroughOn(),
    collapsed: win.isCollapsedNow(),
    alwaysOnTop: getSettings().window.alwaysOnTop,
    opacity: getSettings().window.opacity,
    stealth: getSettings().window.stealthOnShare
  }))

  /* -------- 快捷键 -------- */
  ipcMain.handle('hotkeys:check', (_e, arg: { action: keyof HotkeySettings; accelerator: string }) =>
    hotkeys.detectConflict(arg.accelerator, arg.action)
  )
  ipcMain.handle('hotkeys:update', (_e, arg: { action: keyof HotkeySettings; accelerator: string }) => {
    const r = hotkeys.updateHotkey(arg.action, arg.accelerator)
    broadcast('settings:changed', sanitizedSettings())
    return r
  })
  ipcMain.handle('hotkeys:status', () => hotkeys.getHotkeyStatus())

  /* -------- 截图 -------- */
  /**
   * 拍完再闪光。
   *
   * 顺序不能反：闪光层是本窗口内的全屏白罩（`.flash`），
   * 先闪再拍会把它一起拍进截图里。
   *
   * 这里也顺带把原本"半截"的功能接上了 ——
   * `flashScreenshot()` 和渲染层的 `ui:flash` 订阅、`.flash` 样式一直都在，
   * 但发送端从来没有被调用过，用户截图时得不到任何视觉确认。
   */
  const shoot = async (region?: capture.CaptureRegion, sourceId?: string) => {
    const res = await capture.captureScreen(region, sourceId)
    win.flashScreenshot()
    return res
  }

  ipcMain.handle('capture:sources', () => capture.listSources())
  ipcMain.handle('capture:screen', async (_e, arg: { region?: capture.CaptureRegion; sourceId?: string } = {}) => {
    const res = await shoot(arg.region, arg.sourceId)
    mem.addScreenshot()
    return res
  })

  /* -------- STT（双通道） -------- */
  ipcMain.handle('stt:start', async () => {
    const { started, failed } = await startSTT()
    return { ok: true, started, failed }
  })
  ipcMain.handle('stt:stop', async (_e, arg?: { channel?: STTChannel }) => {
    const results = await stopSTT(arg?.channel)
    // 兼容旧调用方：无 channel 时把首条结果（面试官优先）作为 text 返回
    const text = results.find((r) => r.channel === 'interviewer')?.text ?? results[0]?.text ?? ''
    return { ok: true, text, results }
  })
  ipcMain.on('stt:audio', (_e, payload: ArrayBuffer | { channel: STTChannel; buffer: ArrayBuffer }) => {
    // 兼容两种载荷：裸 ArrayBuffer（旧）与 { channel, buffer }（双通道）
    const isObj = payload && !(payload instanceof ArrayBuffer) && !ArrayBuffer.isView(payload)
    const channel: STTChannel = isObj ? (payload as { channel: STTChannel }).channel : 'interviewer'
    const raw = isObj ? (payload as { buffer: ArrayBuffer }).buffer : (payload as ArrayBuffer)

    // 关键：这里**不能**用 ensureSession()。
    // stt:start 失败（没配 Key）或尚未返回时到达的音频帧若凭空建出会话，
    // 后续每一帧都会往里堆 PCM 且永远没人清理 → 持续录音必然 OOM。
    const session = getSession(channel)
    if (!session) return

    const buf = Buffer.from(raw)
    session.pcmChunks.push(buf)
    session.pcmBytes += buf.length

    // 实时模式下音频随来随走，不需要留在本地；只有离线模式才要攒整段
    if (!session.realtime && session.pcmBytes > MAX_STT_BUFFER_BYTES) {
      const dropCount = Math.ceil(session.pcmChunks.length / 2)
      session.pcmChunks = session.pcmChunks.slice(dropCount)
      session.pcmBytes = session.pcmChunks.reduce((n, b) => n + b.length, 0)
      console.warn(`[stt:${channel}] 离线缓冲区超限，已丢弃最早的音频片段以保证内存可控`)
    }

    session.vad?.push(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)))
    session.realtime?.sendAudio(buf)
  })
  ipcMain.handle('stt:transcribe', async (_e, arg: { audio: ArrayBuffer; sampleRate?: number }) => {
    const s = getSettings()
    const buf = Buffer.from(arg.audio)
    const sr = arg.sampleRate ?? s.stt.sampleRate
    const wav = encodeWav(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)), sr)
    const text = await transcribeFile(
      cloud.asrConn(),
      { ...s.stt, model: cloud.clampModel('asr', s.stt.model, 'file') },
      wav,
      2
    )
    return { text }
  })
  ipcMain.handle('stt:test', async () => {
    const s = getSettings()
    // 未登录 / 网关不可达要在这里变成一条可读提示，而不是抛异常穿透到渲染层
    let conn
    try {
      conn = cloud.asrConn()
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
    return await testDashScope(conn, s.stt)
  })

  /* -------- LLM -------- */
  ipcMain.handle('llm:ask', (_e, arg: { text: string; history?: ChatMessage[] }) => {
    const id = randomUUID()
    const system = buildSystemPrompt(arg.text)
    runLLMStream({ id, system, user: arg.text, history: arg.history })
    return id
  })

  ipcMain.handle('llm:askTranscript', (_e, arg: { text: string; history?: ChatMessage[] }) =>
    askFromTranscript(arg.text, arg.history ?? [])
  )

  ipcMain.handle('llm:askImage', (_e, arg: { imageDataUrl: string; text?: string; history?: ChatMessage[] }) => {
    const id = randomUUID()
    const { system, user } = buildScreenshotPrompt()
    const composed = arg.text?.trim() ? `${user}\n\n补充要求：${arg.text}` : user
    runLLMStream({ id, system, user: composed, history: arg.history, imageDataUrl: arg.imageDataUrl })
    return id
  })

  /**
   * 截图 + 提问一体化。
   *
   * 旧链路是：主进程截图 → dataUrl 通过 IPC 传到渲染层 → 渲染层再 invoke 回主进程 → 才发现起不等于。
   * 一张 1024 宽的图 base64 约 240KB，这条链路让它在进程间白白走了两趟。
   * 现在截图完成就地发起 LLM 请求，只把压缩后的小缩略图回传用于展示。
   */
  ipcMain.handle('llm:askShot', async (_e, arg: { text?: string; history?: ChatMessage[] } = {}) => {
    const shot = await shoot()
    mem.addScreenshot()
    const id = randomUUID()
    const { system, user } = buildScreenshotPrompt()
    const composed = arg.text?.trim() ? `${user}\n\n补充要求：${arg.text}` : user
    runLLMStream({ id, system, user: composed, history: arg.history, imageDataUrl: shot.dataUrl })
    return {
      id,
      thumbDataUrl: capture.thumbnailFromDataUrl(shot.dataUrl),
      width: shot.width,
      height: shot.height,
      timings: shot.timings
    }
  })

  ipcMain.handle('llm:regenerate', (_e, arg: { history: ChatMessage[] }) => {
    // 去掉最后一轮 assistant，用倒数第二条 user 重新生成
    const h = [...(arg.history ?? [])]
    while (h.length && h[h.length - 1].role !== 'user') h.pop()
    if (!h.length) throw new Error('没有可重新生成的内容')
    h.pop()
    const lastUser = [...(arg.history ?? [])].reverse().find((m) => m.role === 'user')
    if (!lastUser) throw new Error('没有可重新生成的内容')
    const id = randomUUID()
    const system = buildSystemPrompt(lastUser.content)
    runLLMStream({
      id,
      system,
      user: lastUser.content,
      history: h,
      // 重新生成时如果原消息是截图，保留同一张图片
      imageDataUrl: lastUser.kind === 'screenshot' ? lastUser.imageDataUrl : undefined
    })
    return id
  })

  ipcMain.handle('llm:abort', () => {
    activeAbort?.abort()
    activeAbort = null
    return true
  })

  ipcMain.handle('llm:test', () => testLLM())
  ipcMain.handle('llm:models', () => listModels())

  /* -------- 知识库 -------- */
  ipcMain.handle('kb:list', () => kb.listKnowledge())
  ipcMain.handle('kb:reload', (_e, dir?: string) => kb.loadKnowledge(dir))
  ipcMain.handle('kb:search', (_e, arg: { query: string; topK?: number; category?: string }): KnowledgeHit[] =>
    kb.searchKnowledge(arg.query, arg.topK ?? 5, arg.category)
  )
  ipcMain.handle('kb:get', (_e, id: string) => kb.getDoc(id))
  ipcMain.handle('kb:save', (_e, arg: { id: string; content: string }) => kb.saveDoc(arg.id, arg.content))
  ipcMain.handle('kb:create', (_e, arg: { name: string; category: string }) => kb.createDoc(arg.name, arg.category))
  ipcMain.handle('kb:delete', (_e, id: string) => kb.deleteDoc(id))
  ipcMain.handle('kb:openDir', () => {
    const dir = getSettings().knowledgeDir || getDefaultKnowledgeDir()
    kb.ensureKnowledgeDir(dir)
    void shell.openPath(dir)
    return dir
  })
  ipcMain.handle('kb:context', (_e, arg: { query: string }) => buildContext(arg.query))

  /* -------- 记忆库 -------- */
  ipcMain.handle('memory:list', () => mem.listMemories())
  ipcMain.handle('memory:search', (_e, q: mem.MemoryQuery) => mem.searchMemories(q ?? {}))
  ipcMain.handle('memory:add', (_e, item: Partial<MemoryItem>) => mem.addMemory(item))
  ipcMain.handle('memory:update', (_e, arg: { id: string; patch: Partial<MemoryItem> }) =>
    mem.updateMemory(arg.id, arg.patch)
  )
  ipcMain.handle('memory:delete', (_e, id: string) => {
    mem.deleteMemory(id)
    return true
  })
  ipcMain.handle('memory:clear', () => {
    mem.clearMemories()
    return true
  })
  ipcMain.handle('memory:stats', () => mem.memoryStats())
  ipcMain.handle('memory:due', (_e, limit?: number) => mem.dueCards(limit ?? 20))
  ipcMain.handle('memory:review', (_e, arg: { id: string; result: 'mastered' | 'fuzzy' | 'unknown' }) =>
    mem.reviewCard(arg.id, arg.result)
  )
  ipcMain.handle('memory:exportJson', () => mem.exportMemories())
  ipcMain.handle('memory:exportMarkdown', () => mem.exportMemoriesMarkdown())
  ipcMain.handle('memory:import', (_e, arg: { json: string; mode?: 'merge' | 'replace' }) =>
    mem.importMemories(arg.json, arg.mode ?? 'merge')
  )
  ipcMain.handle('memory:saveFile', async (_e, arg: { content: string; ext: 'json' | 'md' }) => {
    const w = win.getMainWindow()
    const res = await dialog.showSaveDialog(w!, {
      title: '导出记忆库',
      defaultPath: path.join(app.getPath('downloads'), `面试记忆库-${new Date().toISOString().slice(0, 10)}.${arg.ext}`),
      filters: [{ name: arg.ext === 'json' ? 'JSON' : 'Markdown', extensions: [arg.ext] }]
    })
    if (res.canceled || !res.filePath) return { ok: false }
    fs.writeFileSync(res.filePath, arg.content, 'utf8')
    return { ok: true, path: res.filePath }
  })
  ipcMain.handle('memory:pickFile', async () => {
    const w = win.getMainWindow()
    const res = await dialog.showOpenDialog(w!, {
      title: '导入记忆库',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths.length) return null
    return fs.readFileSync(res.filePaths[0], 'utf8')
  })

  /* -------- 面试会话 -------- */
  ipcMain.handle('session:start', (_e, meta: { company: string; role: string; round: string }) => {
    const s = mem.startSession(meta)
    broadcast('session:changed', s)
    return s
  })
  ipcMain.handle('session:current', () => mem.currentSessionOrNull())
  ipcMain.handle('session:list', () => mem.listSessions())
  ipcMain.handle('session:delete', (_e, id: string) => {
    mem.deleteSession(id)
    return true
  })
  ipcMain.handle('session:end', async () => {
    const ended = mem.endSession()
    broadcast('session:changed', null)
    if (!ended) return { ok: false, message: '当前没有进行中的面试' }
    const s = getSettings()
    if (s.memory.enabled && s.memory.autoReview) {
      // 异步复盘，不阻塞 UI
      void runReview(ended.id).catch((err) => {
        broadcast('review:error', { message: (err as Error).message })
      })
      return { ok: true, session: ended, review: 'running' }
    }
    return { ok: true, session: ended, review: 'skipped' }
  })
  ipcMain.handle('review:run', async (_e, sessionId: string) => {
    try {
      const items = await runReview(sessionId)
      return { ok: true, count: items.length }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  /* -------- 提示词 -------- */
  ipcMain.handle('prompt:preview', (_e, arg: { kind: 'system' | 'screenshot' | 'transcript' | 'review'; sample?: string }) => {
    const s = getSettings()
    const sample = arg.sample ?? '示例：请介绍一下 Redis 的持久化机制'
    const ctx = buildContext(sample)
    const vars = baseVars({ transcript: sample, knowledge: ctx.knowledge, memory: ctx.memory, material: '（示例材料）' })
    const rendered = renderTemplate(s.prompts[arg.kind], vars)
    return {
      rendered,
      unknownVars: findUnknownVars(s.prompts[arg.kind]),
      hits: ctx
    }
  })

  /* -------- 隐私 / 系统 -------- */
  /**
   * 一键清除：记忆库 + 全部面试会话（含转写）+ 进行中的会话 + 截图缓存。
   * 早期版本只清了 memory.json，而最敏感的**语音转写全文**存在 sessions.json 里，
   * 点了「清除全部历史」却原样躺着 —— 属于承诺与实现不一致。
   * 知识库 Markdown 是用户自己的资料，不在这里删除。
   */
  ipcMain.handle('privacy:clearAll', () => {
    mem.clearAllHistory()
    return { ok: true }
  })
  ipcMain.handle('app:openUserData', () => {
    void shell.openPath(getUserDataDir())
    return getUserDataDir()
  })
  ipcMain.handle('app:version', () => app.getVersion())

  /*
   * 注意：kb:changed / memory:changed 的广播**统一在 index.ts 里订阅**（那里会带上 payload）。
   * 这里千万不要再订阅一次 —— 两个订阅点会让每次知识库 reload / 记忆变更都广播两遍，
   * 渲染层（App 的徽标、KnowledgePanel、MemoryPanel）就会重复拉两次数据。
   */
}

export { broadcast }

/**
 * 退出前释放主进程持有的长连接 / 在途流 / 音频缓冲。
 *
 * 为什么必须有：`will-quit` 原本只 `unregisterAllHotkeys()`，
 * 转写 WebSocket、在途 LLM 流、以及离线模式攒下的 PCM（上限 38MB）全都随进程遗留。
 * 后果是服务端连接不会优雅关闭（继续占用配额），强杀前内存也不会释放。
 *
 * 由 `index.ts` 的 `will-quit` 调用。
 */
export function disposeRuntime() {
  for (const [channel, session] of sttSessions) {
    if (session.realtime) {
      try {
        session.realtime.abort()
      } catch (err) {
        console.error(`[ipc] 退出时关闭 ${channel} 转写连接失败`, err)
      }
    }
  }
  sttSessions.clear()

  if (activeAbort) {
    try {
      activeAbort.abort()
    } catch (err) {
      console.error('[ipc] 退出时中断 LLM 流失败', err)
    }
    activeAbort = null
  }
  // 在途的网关请求（登录/兑换/刷新额度）也要断掉，否则会留一个挂着的 socket
  cloud.abortCloudRequests()
  llmBusy = false
}
