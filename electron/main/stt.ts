import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { STTSettings } from '../shared/types'
import { noteUnauthenticated, type AsrConn } from './cloud'

/**
 * 重试没有意义的错误：认证失败、额度耗尽、并发超限、模型不在白名单。
 *
 * 这几类都是**确定性拒绝** —— 再试 2 次只会让用户多等 2 秒、并在网关侧多留几条日志。
 * 而且额度类错误重试还可能触发网关的限流，把问题放大。
 */
class FatalSTTError extends Error {}

/* --------------------------- 能量型 VAD 分段器 --------------------------- */

/**
 * 客户端 VAD：按能量阈值切分音频段。
 * 服务端（paraformer）本身有句子级断句，这里主要用于
 *  - 过滤纯静音，避免空转写
 *  - 长录音的自动分段，配合"自动发送"
 */
export class VadSegmenter {
  private buf: number[] = []
  private silenceMs = 0
  private speaking = false
  private readonly threshold: number
  private readonly silenceLimitMs: number
  private readonly sampleRate: number
  private readonly onSegment: (pcm: Int16Array) => void

  constructor(opts: {
    sampleRate: number
    threshold: number
    silenceMs: number
    onSegment: (pcm: Int16Array) => void
  }) {
    this.sampleRate = opts.sampleRate
    this.threshold = Math.max(0.001, Math.min(1, opts.threshold))
    this.silenceLimitMs = opts.silenceMs
    this.onSegment = opts.onSegment
  }

  push(pcm: Int16Array) {
    let energy = 0
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] / 32768
      energy += v * v
    }
    const rms = Math.sqrt(energy / Math.max(1, pcm.length))
    const chunkMs = (pcm.length / this.sampleRate) * 1000

    if (rms > this.threshold) {
      this.speaking = true
      this.silenceMs = 0
      for (let i = 0; i < pcm.length; i++) this.buf.push(pcm[i])
    } else if (this.speaking) {
      this.silenceMs += chunkMs
      for (let i = 0; i < pcm.length; i++) this.buf.push(pcm[i])
      if (this.silenceMs >= this.silenceLimitMs) {
        this.flush()
      }
    }

    // 单段最长 60s 强制切分，避免内存无限增长
    if (this.buf.length > this.sampleRate * 60) this.flush()
  }

  flush() {
    if (this.buf.length < this.sampleRate * 0.25) {
      // 太短，视为噪声
      this.buf = []
      this.speaking = false
      this.silenceMs = 0
      return
    }
    const seg = Int16Array.from(this.buf)
    this.buf = []
    this.speaking = false
    this.silenceMs = 0
    this.onSegment(seg)
  }

  reset() {
    this.buf = []
    this.silenceMs = 0
    this.speaking = false
  }
}

/* ------------------------- 实时流式转写（WebSocket） ------------------------- */

export interface RealtimeEvents {
  partial: (text: string, sentenceEnd: boolean) => void
  final: (text: string) => void
  error: (message: string) => void
  state: (state: 'idle' | 'connecting' | 'listening' | 'error') => void
}

export class DashScopeRealtime extends EventEmitter {
  private ws: WebSocket | null = null
  private taskId = ''
  private started = false
  private closed = false
  private fullText = ''
  private readyResolve: (() => void) | null = null
  private readyReject: ((e: Error) => void) | null = null

  constructor(
    private conn: AsrConn,
    private settings: STTSettings
  ) {
    super()
  }

  get isActive() {
    return !!this.ws && !this.closed
  }

  async start(retries = 2): Promise<void> {
    const url = this.conn.wsUrl
    this.taskId = randomUUID().replace(/-/g, '')
    this.closed = false
    this.fullText = ''

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.connectOnce(url)
        return
      } catch (err) {
        // 确定性拒绝不重试（额度用完、登录过期、并发超限…）
        if (err instanceof FatalSTTError) {
          this.emit('error', err.message)
          this.emit('state', 'error')
          throw err
        }
        if (attempt === retries) {
          this.emit('error', `${this.conn.cloud ? '云端转写' : '百炼实时转写'}连接失败：${(err as Error).message}`)
          this.emit('state', 'error')
          throw err
        }
        await sleep(400 * (attempt + 1))
      }
    }
  }

  private connectOnce(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.emit('state', 'connecting')
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.conn.apiKey}`,
          'X-DashScope-DataInspection': 'enable',
          'User-Agent': 'canmouguan/0.1'
        },
        handshakeTimeout: 12000
      })
      this.ws = ws
      this.readyResolve = resolve
      this.readyReject = reject

      /**
       * 握手被**拒绝**时的处理。
       *
       * 云端模式下这是最常见的失败面：登录过期（401）、额度用完（402）、
       * 并发超限（429）。网关在响应体里写了人话，直接读出来展示 ——
       * 否则 `ws` 只会抛一句 `Unexpected server response: 402`，
       * 用户完全不知道该怎么办。
       */
      ws.on('unexpected-response', (_req, res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8')
        })
        res.on('end', () => {
          const detail = body.trim().slice(0, 300)
          const isDashboard = res.statusCode === 404 || (res.statusCode ?? 0) >= 500
          const message = this.conn.cloud
            ? {
                401: '登录已过期，请重新登录',
                402: detail || '语音额度已用完，兑换或开通会员后可继续使用',
                429: detail || '同时进行的实时转写已达上限，请先停止当前录音'
              }[res.statusCode ?? 0] || `云端转写被拒绝（HTTP ${res.statusCode}）：${detail}`
            : `转写服务拒绝连接（HTTP ${res.statusCode}）：${detail}`
          // 401 = 凭据失效：必须清掉本地 token，让应用回到登录页。
          // 只弹一条"请重新登录"是不够的 —— 主界面还在，而登录页只在未登录时出现。
          if (this.conn.cloud && res.statusCode === 401) noteUnauthenticated(message)
          const err =
            isDashboard || this.conn.cloud ? new FatalSTTError(message) : new Error(message)
          this.emit('error', message)
          this.readyReject?.(err)
          this.readyReject = null
          try {
            ws.terminate()
          } catch {
            /* noop */
          }
        })
      })

      ws.on('open', () => {
        const s = this.settings
        const payload = {
          header: {
            action: 'run-task',
            task_id: this.taskId,
            streaming: 'duplex'
          },
          payload: {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model: s.model,
            input: {},
            parameters: {
              format: s.audioFormat === 'pcm16' ? 'pcm' : 'wav',
              sample_rate: s.sampleRate,
              disfluency_removal_enabled: false,
              language_hints: s.languageHints?.length ? s.languageHints : ['zh', 'en'],
              // ITN：数字/标点规范化（口语转书面）
              enable_itn: s.enableITN !== false
            }
          }
        }
        ws.send(JSON.stringify(payload), (err) => {
          if (err) reject(err)
        })
      })

      ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) return
        let msg: {
          header?: { event?: string; error_message?: string; error_code?: string }
          payload?: { output?: { sentence?: { text?: string; sentence_end?: boolean } } }
        }
        try {
          msg = JSON.parse(data.toString('utf8'))
        } catch (err) {
   console.error('[stt] 忽略异常', err)
          return
        }
        this.handleMessage(msg)
      })

      ws.on('error', (err: Error) => {
        this.emit('error', err.message || 'WebSocket 错误')
        this.readyReject?.(err)
        this.readyReject = null
      })

      ws.on('close', () => {
        this.closed = true
        this.started = false
        this.emit('state', 'idle')
      })
    })
  }

  private handleMessage(msg: {
    header?: { event?: string; error_message?: string; error_code?: string }
    payload?: { output?: { sentence?: { text?: string; sentence_end?: boolean } } }
  }) {
    const event = msg.header?.event
    if (event === 'task-started') {
      this.started = true
      this.emit('state', 'listening')
      this.readyResolve?.()
      this.readyResolve = null
      return
    }
    if (event === 'task-failed') {
      const code = msg.header?.error_code ?? ''
      const detail = msg.header?.error_message ?? ''
      /**
       * 额度熔断复用 `task-failed` 事件（见网关 `relay-asr.js`）——
       * 这样客户端不需要为"额度耗尽"新增协议分支。但**文案要自己说人话**：
       * 直接展示 `QuotaExceeded` 用户看不懂，也不知道接下来该做什么。
       */
      const errMsg =
        code === 'QuotaExceeded'
          ? detail || '语音额度已用完，录音已自动停止。兑换或开通会员后可继续使用。'
          : code === 'ModelNotAllowed'
            ? detail || '当前语音模型不在云端可用列表内'
            : `${this.conn.cloud ? '云端转写' : '百炼'}任务失败：${code} ${detail}`
      this.emit('error', errMsg)
      this.readyReject?.(new FatalSTTError(errMsg))
      this.readyReject = null
      try {
        this.ws?.close()
      } catch (err) {
        console.error('[stt] 忽略异常', err)
        /* noop */
      }
      return
    }
    if (event === 'task-finished') {
      try {
        this.ws?.close()
      } catch (err) {
   console.error('[stt] 忽略异常', err)
        /* noop */
      }
      return
    }
    if (event === 'result-generated') {
      const sentence = msg.payload?.output?.sentence
      if (!sentence) return
      const text = sentence.text ?? ''
      const end = sentence.sentence_end === true
      this.emit('partial', text, end)
      if (end && text.trim()) {
        this.fullText += (this.fullText ? ' ' : '') + text.trim()
        this.emit('segment', text.trim())
      }
      return
    }
  }

  sendAudio(pcm: Buffer) {
    if (!this.ws || !this.started || this.closed) return
    if (this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(pcm, { binary: true }, (err) => {
        if (err) this.emit('error', `音频发送失败：${err.message}`)
      })
    } catch (err) {
      this.emit('error', `音频发送失败：${(err as Error).message}`)
    }
  }

  async finish(): Promise<string> {
    if (!this.ws || this.closed) return this.fullText.trim()
    const ws = this.ws
    if (this.started && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(
          JSON.stringify({
            header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' },
            payload: { input: {} }
          })
        )
      } catch (err) {
        console.error('[stt] 忽略异常', err)
        /* noop */
      }
    }
    // 发出 finish 后服务端还会把缓冲里的句子吐回来。
    // 原先写死 sleep(600ms) 就 disconnect，长句或网络稍慢时最后一段会被切掉；
    // 这里等到「500ms 内没有新内容」为止，最多等 2.5s。
    await this.waitForTail()
    try {
      ws.close()
    } catch (err) {
      console.error('[stt] 忽略异常', err)
      /* noop */
    }
    return this.fullText.trim()
  }

  private waitForTail(pollMs = 100, idleMs = 500, maxMs = 2500): Promise<void> {
    return new Promise((resolve) => {
      const startedAt = Date.now()
      let lastLen = this.fullText.length
      let lastChangeAt = Date.now()
      const timer = setInterval(() => {
        if (this.fullText.length !== lastLen) {
          lastLen = this.fullText.length
          lastChangeAt = Date.now()
          return
        }
        if (Date.now() - lastChangeAt >= idleMs || Date.now() - startedAt >= maxMs) {
          clearInterval(timer)
          resolve()
        }
      }, pollMs)
    })
  }

  abort() {
    try {
      this.ws?.close()
    } catch (err) {
   console.error('[stt] 忽略异常', err)
      /* noop */
    }
    this.ws = null
    this.closed = true
  }
}

/* --------------------------- 非实时（文件）转写 --------------------------- */

export async function transcribeFile(
  conn: AsrConn,
  settings: STTSettings,
  wav: Buffer,
  retries = 2
): Promise<string> {
  const url = conn.httpUrl

  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const form = new FormData()
      const blob = new Blob([new Uint8Array(wav)], { type: 'audio/wav' })
      form.append('file', blob, 'audio.wav')
      form.append('model', settings.model)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 45000)
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${conn.apiKey}` },
          body: form,
          signal: controller.signal
        })
      } finally {
        // 必须放 finally：fetch 抛错（网络不可达 / 被 abort）时原来会跳过 clearTimeout，
        // 而这里有最多 3 轮重试 → 会残留最多 3 个 45s 的挂起定时器，拖住事件循环、延迟退出。
        clearTimeout(timer)
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        // 网关的错误信封是 { ok:false, reason, message }，把 message 抠出来给人看
        const friendly = parseGatewayError(txt)
        const message = friendly || `HTTP ${res.status} ${txt.slice(0, 300)}`
        // 401 = 凭据失效，同样是"清了本地 token 才能恢复"的情形
        if (res.status === 401) noteUnauthenticated(message)
        // 4xx 是确定性拒绝（额度/鉴权/模型），重试无意义
        if (res.status >= 400 && res.status < 500) throw new FatalSTTError(message)
        throw new Error(message)
      }
      const json = (await res.json()) as { text?: string }
      return (json.text ?? '').trim()
    } catch (err) {
      lastErr = err as Error
      if (err instanceof FatalSTTError) break
      if (attempt < retries) await sleep(500 * (attempt + 1))
    }
  }
  throw new Error(`离线转写失败：${lastErr?.message ?? '未知错误'}`)
}

/** 网关失败响应是 `{"ok":false,"reason":"…","message":"…"}`；把 message 提出来当文案 */
function parseGatewayError(text: string): string {
  try {
    const obj = JSON.parse(text) as { message?: string }
    return typeof obj.message === 'string' ? obj.message : ''
  } catch {
    return ''
  }
}

/* ------------------------------ 连通性自检 ------------------------------ */

export async function testDashScope(conn: AsrConn, settings: STTSettings) {
  const started = Date.now()
  try {
    if (settings.mode === 'realtime') {
      const rt = new DashScopeRealtime(conn, settings)
      await rt.start(0)
      rt.abort()
      return { ok: true as const, message: '实时通道握手成功', latencyMs: Date.now() - started }
    }
    // 离线模式：用一段 0.3s 静音 WAV 打一次接口，验证 Key / 模型 / Endpoint
    const sr = settings.sampleRate
    const wav = encodeWav(Int16Array.from({ length: Math.floor(sr * 0.3) }, () => 0), sr)
    const text = await transcribeFile(conn, settings, wav, 0)
    return {
      ok: true as const,
      message: `离线通道可用（返回「${text || '空音频'}」）`,
      latencyMs: Date.now() - started
    }
  } catch (err) {
    return { ok: false as const, message: (err as Error).message }
  }
}

/** 把 PCM16 单声道编码为 WAV，用于离线转写 */
export function encodeWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataSize = pcm.length * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)
  const view = new Int16Array(buf.buffer, buf.byteOffset + 44, pcm.length)
  view.set(pcm)
  return buf
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
