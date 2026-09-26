import OpenAI from 'openai'
import { getSettings } from './store'
import { llmTarget, loadModelCatalog, noteUnauthenticated } from './cloud'

/* --------------------------------- 类型 --------------------------------- */

export type ContentPartText = { type: 'text'; text: string }
export type ContentPartImage = { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
export type ContentPart = ContentPartText | ContentPartImage

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

// 从 SDK 实例方法反推参数类型，避免依赖具体版本的命名空间导出路径
type CreateParams = Parameters<OpenAI['chat']['completions']['create']>[0]
type SDKMessages = NonNullable<CreateParams['messages']>
type SDKMessage = SDKMessages[number]

export interface StreamHandlers {
  onDelta: (delta: string) => void
  onDone: (full: string) => void
  onError: (message: string) => void
  /**
   * 推理模型（glm-5 / R1 / o-series 等）先把"思考链"吐出来，正文要等很久才到。
   * 有了这个回调 UI 就能显示"思考中"，否则用户看到的是一片空白 + 毫无反馈的干等。
   */
  onThinking?: () => void
}

/**
 * 复用 SDK 实例。每次提问都 new 一个 OpenAI client 会造成 UDP/TCP 连接反复建立，
 * 首 token 延迟里有一截是纯粹的握手开销。按「配置指纹」缓存即可。
 */
const clientCache = new Map<string, { client: OpenAI; model: string; visionModel: string; maxTokens: number; temperature: number }>()
const CLIENT_CACHE_MAX = 8

function fingerprint(id: string, key: string, url: string, timeout: number, retries: number): string {
  return [id, url, timeout, retries, key.length, key.slice(-6)].join('|')
}

function activeClient(): {
  client: OpenAI
  model: string
  visionModel: string
  maxTokens: number
  temperature: number
} {
  const s = getSettings()
  const profile = s.llm.profiles.find((p) => p.id === s.llm.activeProfileId) ?? s.llm.profiles[0]
  if (!profile) throw new Error('配置缺失：settings.llm.profiles 为空')

  /**
   * 落点**永远**是网关：`baseURL` 指向网关、`apiKey` 用登录 token、模型取网关白名单内的默认值。
   *
   * ⚠️ 这里刻意**不读** `profile.baseURL` / `profile.apiKeyEnc`。
   * 那两个字段还在（标了 `@deprecated`），但主进程一行都不碰 ——
   * "完全屏蔽用户自带 Key"必须是结构性的，不能只靠"界面上没有入口"。
   *
   * 其余（温度 / maxTokens / 超时 / 重试）仍沿用 profile —— 那是体验参数，
   * 与"谁来付上游的钱"无关，没必要跟着一起砍掉。
   */
  const { baseURL, apiKey, model, visionModel } = llmTarget({
    model: profile.model,
    visionModel: profile.visionModel
  })
  const timeout = profile.timeoutMs || 60000
  const maxRetries = Math.max(0, Math.min(5, profile.retries ?? 1))

  // 指纹里只放 Key 的长度与尾缀：既能感知"换了 Key"，又不把完整密钥留在进程内存里当索引
  const fp = fingerprint('cloud', apiKey, baseURL, timeout, maxRetries)
  const cached = clientCache.get(fp)
  if (cached) {
    // 模型/温度/maxTokens 可能被改过但没有重建连接，这里按最新设置覆盖
    cached.model = model
    cached.visionModel = visionModel
    cached.maxTokens = profile.maxTokens || 2048
    cached.temperature = profile.temperature ?? 0.3
    return cached
  }

  const client = new OpenAI({
    apiKey: apiKey || 'sk-placeholder',
    baseURL,
    timeout,
    // 网络层重试交给 SDK，业务层另有一层（见 ipc 的 runWithRetry）
    maxRetries
  })
  const entry = {
    client,
    model,
    visionModel,
    maxTokens: profile.maxTokens || 2048,
    temperature: profile.temperature ?? 0.3
  }
  if (clientCache.size >= CLIENT_CACHE_MAX) {
    // 简单的 FIFO 淘汰：Map 的迭代顺序即插入顺序
    const oldest = clientCache.keys().next().value
    if (oldest) clientCache.delete(oldest)
  }
  clientCache.set(fp, entry)
  return entry
}

/** 设置变更（换 Key / 换 BaseURL）后调用，丢弃全部复用实例 */
export function clearClientCache(): void {
  clientCache.clear()
}

function toSDKMessages(messages: LLMMessage[]): SDKMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content })) as unknown as SDKMessage[]
}

export interface ChatOptions {
  messages: LLMMessage[]
  /** 传入图片则自动切换到视觉模型 */
  imageDataUrl?: string
  model?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** 上下文窗口：保留最近多少轮 user+assistant 对话（默认 4） */
  maxContextTurns?: number
  /** 图片 detail 级别：low 大幅减少 token，auto 让模型自行决定 */
  imageDetail?: 'auto' | 'low' | 'high'
}

/** 截断 message 历史，只保留最近 N 轮，并剔除历史图片（避免 base64 反复传输膨胀）。 */
function trimMessages(messages: LLMMessage[], maxTurns: number): LLMMessage[] {
  if (maxTurns <= 0) return messages
  // 保留 system 指令，再取最近 N 轮 user/assistant
  const system = messages.filter((m) => m.role === 'system')
  const turns = messages.filter((m) => m.role !== 'system')
  const kept = turns.slice(-maxTurns * 2)
  // 历史图片不再发送：如果某条消息是图片+文本数组，仅保留文本部分
  const textOnly = kept.map((m) => {
    if (typeof m.content === 'string') return m
    const textParts = m.content.filter((p) => p.type === 'text') as ContentPartText[]
    return { role: m.role, content: textParts.map((p) => p.text).join('\n') }
  })
  return [...system, ...textOnly]
}

export async function streamChat(opts: ChatOptions, handlers: StreamHandlers): Promise<void> {
  let full = ''
  let firstTokenAt = 0
  let thinkingChars = 0
  let notifiedThinking = false
  const startedAt = Date.now()
  try {
    const { client, model, visionModel, maxTokens, temperature } = activeClient()
    const useVision = !!opts.imageDataUrl
    const targetModel = opts.model ?? (useVision ? visionModel : model)

    // 1. 上下文瘦身：只保留最近 N 轮，历史图片不再重复发送
    const maxTurns = opts.maxContextTurns ?? 4
    const messages: LLMMessage[] = trimMessages(opts.messages.map((m) => ({ ...m })), maxTurns)

    // 2. 当前图片只放最后一条 user 消息里，detail 默认 auto（比 high 快很多）
    if (useVision) {
      const lastUserIdx = messages.length - 1
      if (lastUserIdx >= 0) {
        const last = messages[lastUserIdx]
        const text = typeof last.content === 'string' ? last.content : ''
        messages[lastUserIdx] = {
          role: last.role,
          content: [
            { type: 'image_url', image_url: { url: opts.imageDataUrl!, detail: opts.imageDetail ?? 'auto' } },
            { type: 'text', text }
          ]
        }
      }
    }

    console.log(`[llm] request model=${targetModel} turns=${Math.floor(messages.length / 2)} image=${useVision}`)

    const stream = await client.chat.completions.create(
      {
        model: targetModel,
        messages: toSDKMessages(messages),
        temperature: opts.temperature ?? temperature,
        max_tokens: opts.maxTokens ?? maxTokens,
        stream: true
      },
      { signal: opts.signal }
    )

    for await (const chunk of stream) {
      if (!firstTokenAt) {
        firstTokenAt = Date.now()
        console.log(`[llm] first-token latency=${firstTokenAt - startedAt}ms model=${targetModel}`)
      }
      // 注意：推理模型的正文不在 content 里！
      // 实测智谱 glm-5.3-flash 全部 ~500 个流式包都走 `reasoning_content`（思考链，且不支持关闭），
      // 只读 content 会让界面一片空白地干等十几秒，最后拿到空字符串。这里两种都接。
      const delta = (chunk.choices?.[0]?.delta ?? {}) as {
        content?: string
        reasoning_content?: string
      }
      const thinking = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
      if (thinking) {
        thinkingChars += thinking.length
        if (!notifiedThinking) {
          notifiedThinking = true
          handlers.onThinking?.()
        }
      }
      const content = typeof delta.content === 'string' ? delta.content : ''
      if (content) {
        full += content
        handlers.onDelta(content)
      }
    }
    console.log(
      `[llm] done len=${full.length} thinking=${thinkingChars} total=${Date.now() - startedAt}ms first=${firstTokenAt ? firstTokenAt - startedAt : 'n/a'}ms`
    )

    // 只思考没正文：通常是 max_tokens 被思考链耗尽，或者模型压根没输出正文。
    // 若当作正常完成，用户看到的是一个空气泡，完全无法归因，所以这里明确报错。
    if (!full.trim() && thinkingChars > 0) {
      handlers.onError(
        `模型只输出了思考过程、没有给出正文（思考 ${thinkingChars} 字，多半被 max_tokens 耗尽）。\n` +
          `该模型属于"强制思考"型，不适合面试实时辅助：建议换成非思考模型（如 glm-4-flash / qwen-plus），或调大 max tokens。`
      )
      return
    }

    handlers.onDone(full)
  } catch (err) {
    if ((err as Error).name === 'AbortError' || (err as Error).name === 'APIUserAbortError') {
      handlers.onDone(full)
      return
    }
    handlers.onError(reportLLMError(err))
  }
}

export async function chatOnce(opts: ChatOptions): Promise<string> {
  try {
    const { client, model, maxTokens, temperature } = activeClient()
    const res = await client.chat.completions.create({
      model: opts.model ?? model,
      messages: toSDKMessages(opts.messages),
      temperature: opts.temperature ?? temperature,
      max_tokens: opts.maxTokens ?? maxTokens,
      stream: false
    })
    return res.choices?.[0]?.message?.content ?? ''
  } catch (err) {
    // 复盘等场景直接把结果当文案展示，原始 SDK 报错不够可读
    throw new Error(reportLLMError(err))
  }
}

/**
 * 连通性自检。
 *
 * 刻意用**流式**而不是非流式来测：非流式只能看到一个总耗时，
 * 而面试辅助真正关心的是"第一个字多久出现"。流式还能顺带发现一类致命配置问题——
 * 模型强制思考（glm-5.3-flash / R1 / o-series），它只吐 reasoning_content 不给正文，
 * 界面上就是一片空白地干等十几秒。这种情况在这里明确报出来，而不是留到实战里才发现。
 */
export async function testLLM(): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
  const started = Date.now()
  try {
    const { client, model, maxTokens, temperature } = activeClient()
    const stream = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: '只回复两个字：ok' }],
      temperature,
      max_tokens: Math.min(maxTokens, 128),
      stream: true
    })

    let firstChunkAt = 0
    let firstContentAt = 0
    let text = ''
    let thinkingChars = 0
    for await (const chunk of stream) {
      if (!firstChunkAt) firstChunkAt = Date.now()
      const delta = (chunk.choices?.[0]?.delta ?? {}) as { content?: string; reasoning_content?: string }
      if (delta.reasoning_content) thinkingChars += delta.reasoning_content.length
      if (delta.content) {
        if (!firstContentAt) firstContentAt = Date.now()
        text += delta.content
      }
    }
    const total = Date.now() - started

    if (!text.trim() && thinkingChars > 0) {
      return {
        ok: false,
        latencyMs: total,
        message:
          `模型 ${model} 属于「强制思考」型：本次只输出了 ${thinkingChars} 字思考过程、没有正文。\n` +
          `用它做面试实时辅助会表现为「长时间空白后突然出结果甚至什么都不出」。\n` +
          `建议在上方换成非思考模型（如 glm-4-flash / qwen-plus / deepseek-chat）。`
      }
    }

    return {
      ok: true,
      latencyMs: total,
      message:
        `连接成功（模型 ${model}）\n` +
        `首字延迟 ${firstContentAt ? firstContentAt - started : 'n/a'} ms ｜ 总耗时 ${total} ms\n` +
        (thinkingChars ? `注意：该模型额外输出了 ${thinkingChars} 字思考链，会拖慢响应。\n` : '') +
        `返回：${text.trim().slice(0, 20) || '空'}`
    }
  } catch (err) {
    return { ok: false, message: reportLLMError(err) }
  }
}

export async function listModels(): Promise<string[]> {
  // 问服务端要清单，而不是回一份硬编码列表：网关对非白名单模型是静默改写的，
  // 客户端自己列一份就等于埋下"选了 A 用了 B"的坑。见 cloud.ts 的 clampModel。
  const cat = await loadModelCatalog()
  return [...cat.llm]
}

/**
 * 把错误变成给用户看的话，**顺带处理"登录失效"**。
 *
 * 登录失效必须在这里兜住：token 过期后主界面还开着，但每个功能都会失败，
 * 而登录页只在"未登录"时出现 —— 不主动清掉本地凭据，用户会卡在一个
 * 什么都干不了、也没有登录入口的界面里。清凭据的动作统一在 `cloud.ts`，
 * 这里只负责"发现并上报"。
 */
function reportLLMError(err: unknown): string {
  const message = normalizeLLMError(err)
  const e = err as { status?: number; error?: { reason?: string } }
  if (e?.status === 401 || e?.error?.reason === 'unauthenticated') {
    noteUnauthenticated(message)
  }
  return message
}

export function normalizeLLMError(err: unknown): string {
  const e = err as {
    status?: number
    code?: string
    message?: string
    error?: { message?: string; code?: string; reason?: string }
  }
  const detail = e?.error?.message || e?.message || '未知错误'

  /**
   * 网关的失败响应是 `{ ok:false, reason, message }`，没有 `code` 只有 `reason`。
   * 它的 message 本来就是写给终端用户的中文，**优先原样透出** ——
   * 套一层"请求失败："反而会把"额度已用完，兑换或开通会员后可继续使用"这种
   * 可执行指引淹没在通用措辞里。
   */
  const gatewayReason = e?.error?.reason
  if (gatewayReason) {
    if (gatewayReason === 'unauthenticated') return `${detail}（请重新登录）`
    return detail
  }

  // 最高频配置错误：把完整接口地址当网关地址（多填了 /v1）
  if (e?.status === 404 || /not found|404/i.test(String(detail))) {
    return `网关返回 404：请检查网关地址是否正确（应填到域名/端口，不带 /v1）—— ${detail}`
  }

  if (e?.status === 401 || e?.code === 'invalid_api_key') {
    return `登录已过期，请重新登录 —— ${detail}`
  }
  if (e?.status === 402) return detail
  if (e?.status === 429) return `请求过于频繁（429）：稍后重试或降低并发 —— ${detail}`
  if (e?.status === 403) return `无权限（403）：${detail}`
  if (e?.status && e.status >= 500) return `服务异常（${e.status}）：${detail}`
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(String(detail))) {
    return `网络不可达：请检查网络与网关地址（网关没启动也会是这个提示）—— ${detail}`
  }
  if (/timeout|ETIMEDOUT/i.test(String(detail))) return `请求超时：可在设置中调大超时时间 —— ${detail}`
  return `请求失败：${detail}`
}
