import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  ChatMessage,
  CloudQuota,
  HotkeySettings,
  InterviewSession,
  KnowledgeDoc,
  KnowledgeHit,
  MemoryItem,
  Settings,
  STTChannel,
  TestResult
} from '../shared/types'
import type { CaptureResult, CaptureRegion } from '../main/capture'
import type { MemoryQuery } from '../main/memory'

const api = {
  /* --------- 设置 --------- */
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<Settings & { paths: { userData: string; knowledge: string } }>,
  patchSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:patch', patch),
  /**
   * @deprecated 自带 API Key 的写入通道。界面上已无入口，主进程也不读这些字段
   * （落点恒为网关）。保留只为将来恢复 BYOK 时能直接复用。
   */
  setSecret: (arg: { scope: 'llm' | 'stt'; profileId?: string; value: string }) =>
    ipcRenderer.invoke('settings:setSecret', arg) as Promise<{ ok: boolean }>,
  /** @deprecated 同 `setSecret`。 */
  clearSecret: (arg: { scope: 'llm' | 'stt'; profileId?: string }) =>
    ipcRenderer.invoke('settings:clearSecret', arg) as Promise<{ ok: boolean }>,

  /* --------- 账号（网关） --------- */
  /**
   * 凭据只留在主进程：渲染层**永远拿不到 token**，
   * 只能提交账号/手机号/密码/验证码这类一次性输入，并读回脱敏快照。
   */
  cloudStatus: () =>
    ipcRenderer.invoke('cloud:status') as Promise<{
      /** 解析后的实际网关地址（用户没填时是默认值） */
      baseURL: string
      loggedIn: boolean
      me: CloudQuota | null
    }>,
  cloudPing: () => ipcRenderer.invoke('cloud:ping') as Promise<{ ok: boolean; message: string; smsReady?: boolean }>,
  /**
   * 服务端放行的模型清单。`live: false` 表示用的是内置兜底清单 ——
   * 界面应提示"可能与服务端不一致"，因为网关对非白名单模型是静默改写的。
   */
  cloudModels: () =>
    ipcRenderer.invoke('cloud:models') as Promise<{
      ok: boolean
      llm?: string[]
      asr?: string[]
      defaults?: { llm: string; vision: string }
      live?: boolean
      message?: string
    }>,
  /**
   * 套餐与购买方式。**不需要登录** —— 用户是先买码、再注册的。
   * 价格与购买链接由服务端下发，客户端不写死（改价不必让所有老用户重下客户端）。
   */
  cloudPlans: () =>
    ipcRenderer.invoke('cloud:plans') as Promise<{
      ok: boolean
      currency?: string
      plans?: Array<{ kind: string; name: string; plan: string; days: number; price: number | null }>
      store?: {
        purchaseUrl: string
        contactWechat: string
        contactQq: string
        contactEmail: string
        note: string
      }
      live?: boolean
      message?: string
    }>,
  /** 发短信验证码。`purpose` 决定网关侧文案：`register` 会用"注册"字样 */
  cloudSmsSend: (phone: string, purpose: 'login' | 'register') =>
    ipcRenderer.invoke('cloud:smsSend', { phone, purpose }) as Promise<{
      ok: boolean
      ttlMinutes?: number
      resendAfterMs?: number
      provider?: string
      message?: string
      reason?: string
    }>,
  cloudLogin: (input: { account?: string; phone?: string; password?: string; smsCode?: string }) =>
    ipcRenderer.invoke('cloud:login', input) as Promise<{
      ok: boolean
      me?: CloudQuota | null
      message?: string
    }>,
  cloudRegister: (input: { account?: string; phone?: string; password: string; smsCode?: string; code?: string }) =>
    ipcRenderer.invoke('cloud:register', input) as Promise<{
      ok: boolean
      me?: CloudQuota | null
      message?: string
      warning?: string
    }>,
  cloudRedeem: (code: string) =>
    ipcRenderer.invoke('cloud:redeem', { code }) as Promise<{
      ok: boolean
      me?: CloudQuota | null
      message?: string
    }>,
  cloudRefresh: () =>
    ipcRenderer.invoke('cloud:refresh') as Promise<{ ok: boolean; me?: CloudQuota | null; message?: string }>,
  cloudLogout: () => ipcRenderer.invoke('cloud:logout') as Promise<{ ok: boolean }>,

  /* --------- 窗口 --------- */
  windowAction: (action: string, value?: number | boolean) =>
    ipcRenderer.invoke('window:action', { action, value }) as Promise<boolean>,
  windowState: () =>
    ipcRenderer.invoke('window:state') as Promise<{
      clickThrough: boolean
      collapsed: boolean
      alwaysOnTop: boolean
      opacity: number
      stealth: boolean
    }>,

  /* --------- 快捷键 --------- */
  checkHotkey: (action: keyof HotkeySettings, accelerator: string) =>
    ipcRenderer.invoke('hotkeys:check', { action, accelerator }) as Promise<{ conflict: boolean; reason?: string }>,
  updateHotkey: (action: keyof HotkeySettings, accelerator: string) =>
    ipcRenderer.invoke('hotkeys:update', { action, accelerator }) as Promise<{ ok: boolean; reason?: string }>,
  hotkeyStatus: () => ipcRenderer.invoke('hotkeys:status'),

  /* --------- 截图 --------- */
  listSources: () => ipcRenderer.invoke('capture:sources') as Promise<{ id: string; name: string; type: string; thumbnail: string }[]>,
  captureScreen: (arg: { region?: CaptureRegion; sourceId?: string } = {}) =>
    ipcRenderer.invoke('capture:screen', arg) as Promise<CaptureResult>,

  /* --------- 语音（双通道） --------- */
  sttStart: () =>
    ipcRenderer.invoke('stt:start') as Promise<{
      ok: boolean
      started: STTChannel[]
      failed: { channel: STTChannel; message: string }[]
    }>,
  /** 不传 channel 则停止所有通道；传了就只停那一路 */
  sttStop: (channel?: STTChannel) =>
    ipcRenderer.invoke('stt:stop', channel ? { channel } : undefined) as Promise<{
      ok: boolean
      text: string
      results: { channel: STTChannel; text: string }[]
      message?: string
    }>,
  /** 音频帧必须带通道：主进程按通道各存一份缓冲、各送一个 WebSocket */
  sttAudio: (channel: STTChannel, buffer: ArrayBuffer) => ipcRenderer.send('stt:audio', { channel, buffer }),
  sttTranscribe: (audio: ArrayBuffer, sampleRate?: number) =>
    ipcRenderer.invoke('stt:transcribe', { audio, sampleRate }) as Promise<{ text: string }>,
  sttTest: () => ipcRenderer.invoke('stt:test') as Promise<TestResult>,

  /* --------- LLM --------- */
  llmAsk: (text: string, history?: ChatMessage[]) => ipcRenderer.invoke('llm:ask', { text, history }) as Promise<string>,
  llmAskTranscript: (text: string, history?: ChatMessage[]) =>
    ipcRenderer.invoke('llm:askTranscript', { text, history }) as Promise<string>,
  llmAskImage: (imageDataUrl: string, text?: string, history?: ChatMessage[]) =>
    ipcRenderer.invoke('llm:askImage', { imageDataUrl, text, history }) as Promise<string>,
  llmAskShot: (text?: string, history?: ChatMessage[]) =>
    ipcRenderer.invoke('llm:askShot', { text, history }) as Promise<{
      id: string
      thumbDataUrl: string
      width: number
      height: number
    }>,
  llmRegenerate: (history: ChatMessage[]) => ipcRenderer.invoke('llm:regenerate', { history }) as Promise<string>,
  llmAbort: () => ipcRenderer.invoke('llm:abort') as Promise<boolean>,
  llmTest: () => ipcRenderer.invoke('llm:test') as Promise<TestResult>,
  llmModels: () => ipcRenderer.invoke('llm:models') as Promise<string[]>,

  /* --------- 知识库 --------- */
  kbList: () => ipcRenderer.invoke('kb:list') as Promise<KnowledgeDoc[]>,
  kbReload: (dir?: string) => ipcRenderer.invoke('kb:reload', dir) as Promise<KnowledgeDoc[]>,
  kbSearch: (query: string, topK?: number, category?: string) =>
    ipcRenderer.invoke('kb:search', { query, topK, category }) as Promise<KnowledgeHit[]>,
  kbGet: (id: string) => ipcRenderer.invoke('kb:get', id) as Promise<KnowledgeDoc | undefined>,
  kbSave: (id: string, content: string) => ipcRenderer.invoke('kb:save', { id, content }) as Promise<boolean>,
  kbCreate: (name: string, category: string) => ipcRenderer.invoke('kb:create', { name, category }) as Promise<KnowledgeDoc | null>,
  kbDelete: (id: string) => ipcRenderer.invoke('kb:delete', id) as Promise<boolean>,
  kbOpenDir: () => ipcRenderer.invoke('kb:openDir') as Promise<string>,
  kbPickDir: () => ipcRenderer.invoke('kb:pickDir') as Promise<{ dir: string } | { error: string } | null>,
  kbContext: (query: string) =>
    ipcRenderer.invoke('kb:context', { query }) as Promise<{ knowledge: string; memory: string; hits: number; memHits: number }>,

  /* --------- 记忆库 --------- */
  memList: () => ipcRenderer.invoke('memory:list') as Promise<MemoryItem[]>,
  memSearch: (q: MemoryQuery) => ipcRenderer.invoke('memory:search', q) as Promise<MemoryItem[]>,
  memAdd: (item: Partial<MemoryItem>) => ipcRenderer.invoke('memory:add', item) as Promise<MemoryItem>,
  memUpdate: (id: string, patch: Partial<MemoryItem>) =>
    ipcRenderer.invoke('memory:update', { id, patch }) as Promise<MemoryItem | null>,
  memDelete: (id: string) => ipcRenderer.invoke('memory:delete', id) as Promise<boolean>,
  memClear: () => ipcRenderer.invoke('memory:clear') as Promise<boolean>,
  memStats: () => ipcRenderer.invoke('memory:stats') as Promise<{
    total: number
    byMastery: number[]
    due: number
    topTags: [string, number][]
    topKnowledgePoints: [string, number][]
  }>,
  memDue: (limit?: number) => ipcRenderer.invoke('memory:due', limit) as Promise<MemoryItem[]>,
  memReview: (id: string, result: 'mastered' | 'fuzzy' | 'unknown') =>
    ipcRenderer.invoke('memory:review', { id, result }) as Promise<MemoryItem | null>,
  memExportJson: () => ipcRenderer.invoke('memory:exportJson') as Promise<string>,
  memExportMarkdown: () => ipcRenderer.invoke('memory:exportMarkdown') as Promise<string>,
  memImport: (json: string, mode?: 'merge' | 'replace') =>
    ipcRenderer.invoke('memory:import', { json, mode }) as Promise<number>,
  memSaveFile: (content: string, ext: 'json' | 'md') =>
    ipcRenderer.invoke('memory:saveFile', { content, ext }) as Promise<{ ok: boolean; path?: string }>,
  memPickFile: () => ipcRenderer.invoke('memory:pickFile') as Promise<string | null>,

  /* --------- 面试会话 --------- */
  sessionStart: (meta: { company: string; role: string; round: string }) =>
    ipcRenderer.invoke('session:start', meta) as Promise<{ id: string }>,
  sessionCurrent: () => ipcRenderer.invoke('session:current'),
  sessionList: () => ipcRenderer.invoke('session:list') as Promise<InterviewSession[]>,
  sessionDelete: (id: string) => ipcRenderer.invoke('session:delete', id) as Promise<boolean>,
  sessionEnd: () => ipcRenderer.invoke('session:end') as Promise<{ ok: boolean; review?: string; message?: string }>,
  reviewRun: (sessionId: string) => ipcRenderer.invoke('review:run', sessionId) as Promise<{ ok: boolean; count?: number; message?: string }>,

  /* --------- 提示词 --------- */
  promptPreview: (kind: 'system' | 'screenshot' | 'transcript' | 'review', sample?: string) =>
    ipcRenderer.invoke('prompt:preview', { kind, sample }) as Promise<{
      rendered: string
      unknownVars: string[]
      hits: { hits: number; memHits: number }
    }>,

  /* --------- 隐私 / 系统 --------- */
  clearAll: () => ipcRenderer.invoke('privacy:clearAll') as Promise<{ ok: boolean }>,
  openUserData: () => ipcRenderer.invoke('app:openUserData') as Promise<string>,
  appVersion: () => ipcRenderer.invoke('app:version') as Promise<string>,

  /** Electron 32+ 用 webUtils 获取拖拽文件路径 */
  getFilePath: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch (err) {
      console.error('[preload] getFilePath 失败（非拖拽来源的文件对象）', err)
      return ''
    }
  },

  /* --------- 事件订阅 --------- */
  /** 渲染层只允许监听白名单内的主→渲染事件 */
  on: (channel: typeof ALLOWED_CHANNELS[number], cb: (...args: never[]) => void) => {
    if (!ALLOWED_CHANNELS.includes(channel as never)) {
      throw new Error(`IPC 通道 "${channel}" 未在白名单中，禁止监听`)
    }
    const listener = (_e: unknown, ...args: unknown[]) => cb(...(args as never[]))
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

/** 主进程可能主动推送给渲染层的事件通道白名单 */
const ALLOWED_CHANNELS = [
  'toast',
  'window:state',
  'settings:changed',
  'session:changed',
  'stt:state',
  'stt:partial',
  'stt:final',
  'stt:error',
  'llm:start',
  'llm:delta',
  'llm:thinking',
  'llm:done',
  'llm:error',
  'review:done',
  'review:error',
  'kb:changed',
  'memory:changed',
  'hotkey:toggleRecording',
  'hotkey:screenshot',
  'hotkey:panicHide',
  'hotkey:panicMute',
  'ui:flash'
] as const

export type CanmouguanAPI = typeof api

contextBridge.exposeInMainWorld('canmouguan', api)
