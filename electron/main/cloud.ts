/**
 * 网关接入层：**唯一决定"上游请求发到哪里"的地方**，外加网关的账号接口。
 *
 * ## 只有一种运行形态
 *
 * 全部请求都经自建 `server/` 转发，客户端只持有一个登录 token。
 * **没有"自带 Key"这条路径** —— 不是为了少写代码，而是因为只要它存在，
 * 上游 Key 就必须能被填进来，配额也就必然能被绕过。
 *
 * 所以本文件里**刻意没有任何 `if (走网关) ... else ...` 分支**：
 * `asrConn()` / `llmTarget()` 无条件返回网关落点。
 * "完全屏蔽自有 Key"必须是结构性的，而不是"界面上没有入口"。
 * （`LLMProfile.baseURL` / `apiKeyEnc` / `STTSettings.apiKeyEnc` 等字段仍留在类型里并标了
 * `@deprecated`，但主进程一行都不读——将来要恢复 BYOK 只需恢复界面，不用动 schema。）
 *
 * ## 为什么必须集中在主进程
 *
 * token 就是这一层的"钱袋子"。它一旦进了渲染层，就等于把凭据交给了任意一段注入进
 * 页面的脚本（而 preload 会把整个 `window.canmouguan` 注入到加载进该 webContents 的
 * 任何页面）。所以这里沿用和 API Key 相同的纪律：**只走 safeStorage，渲染层只拿到脱敏副本**。
 */

import { getSettings, saveSettings, encryptSecret, decryptSecret } from './store'
import {
  DEFAULT_GATEWAY_URL,
  DASHSCOPE_MODELS,
  CLOUD_LLM_MODELS,
  CLOUD_LLM_MODEL,
  CLOUD_LLM_VISION_MODEL
} from '../shared/types'
import type { CloudQuota } from '../shared/types'

/* ------------------------------ 基础访问器 ------------------------------ */

/** 去掉尾部斜杠：用户填 `https://x.com/` 与 `https://x.com` 必须等价 */
function normalizeBase(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/\/+$/, '')
}

/** 网关地址。用户没填就用本机默认值，绝不返回空串（空串等于"装完就是死的"）。 */
export function cloudBaseURL(): string {
  return normalizeBase(getSettings().cloud?.baseURL || '') || DEFAULT_GATEWAY_URL
}

/** 网关的 OpenAI 兼容根：SDK 会自己在后面拼 `/chat/completions` */
export function cloudLLMBaseURL(): string {
  return `${cloudBaseURL()}/v1`
}

function cloudToken(): string {
  return decryptSecret(getSettings().cloud?.tokenEnc)
}

/**
 * 是否已登录。
 *
 * 这是**唯一的运行前提** —— 之前那个 `enabled` 开关已经没有意义了：
 * 没登录时唯一能做的就是登录。渲染层的登录闸门（`LoginGate`）以它为准。
 */
export function cloudLoggedIn(): boolean {
  return Boolean(cloudToken())
}

/* ---------------------------- 凭据失效的处理 ---------------------------- */

/**
 * 凭据失效时通知上层。
 *
 * 为什么需要这个回调：`ipc.ts` 才是负责向渲染层广播的地方，而 cloud.ts 不该反过来
 * 依赖 ipc。留一个注册位，由 ipc 在初始化时挂上去 —— 依赖方向是 ipc → cloud，
 * 和现在一致。
 */
let sessionLostHandler: (() => void) | null = null

export function setSessionLostHandler(fn: (() => void) | null): void {
  sessionLostHandler = fn
}

/**
 * 清掉本地凭据。
 *
 * ⚠️ 这件事**必须主动做**，不能只报个错。token 过期后主界面还开着，但每个功能都会失败，
 * 而登录页只在"未登录"时出现 —— 不把凭据清掉，用户就卡在一个什么都干不了、
 * 也找不到登录入口的界面里（只能手动去删 settings.json）。
 */
function clearSession(reason: string): void {
  const s = getSettings()
  if (!s.cloud?.tokenEnc) return
  s.cloud.tokenEnc = undefined
  s.cloud.lastMe = null
  saveSettings(s)
  resetModelCatalog()
  console.warn('[cloud] 登录凭据已失效，已清除：', reason)
  try {
    sessionLostHandler?.()
  } catch (err) {
    console.error('[cloud] 凭据失效回调出错', err)
  }
}

/**
 * 给 LLM / STT 链路用：它们在**自己的**错误处理里发现认证失败时调这个，
 * 统一走"清凭据 + 回登录页"，而不是各自清各自的（那样迟早漏一个）。
 */
export function noteUnauthenticated(detail: string): void {
  clearSession(detail)
}

/** http(s) → ws(s)，保留路径 */
function toWsURL(httpBase: string, path: string): string {
  const base = httpBase.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')
  return `${base}${path}`
}

/* --------------------------- 上游目标的解析 --------------------------- */

/**
 * 语音链路的落点。
 *
 * 网关的实时转写刻意做成与百炼**同构**，所以协议完全一致，
 * 客户端换的只是 URL 与凭据 —— 这也是当初把网关设计成透传而不是另立协议的原因。
 */
export interface AsrConn {
  apiKey: string
  /** 实时转写的 WS 地址，已带 `?token=` 查询参数 */
  wsUrl: string
  /** 文件转写的完整端点 */
  httpUrl: string
  cloud: true
}

/**
 * 解析语音落点。**必须先于任何 STT 调用执行**。
 *
 * 刻意返回一个"落点对象"、并且**不接受任何参数**：这样 stt.ts 里就不可能出现
 * "自己判断该不该走网关"的分支。那个分支迟早会有一个地方漏改，
 * 症状是"录音能跑但计费没计到"——不报错、只漏钱，最难发现的一类 bug。
 */
export function asrConn(): AsrConn {
  const token = cloudToken()
  if (!token) throw new Error('尚未登录，请先在登录页登录账号')
  const base = cloudBaseURL()
  return {
    apiKey: token,
    // 实时转写走 WS 握手，查询参数比自定义握手头更可靠（代理常会剥掉自定义头）
    wsUrl: `${toWsURL(base, '/v1/asr/realtime')}?token=${encodeURIComponent(token)}`,
    httpUrl: `${base}/v1/audio/transcriptions`,
    cloud: true
  }
}

/** LLM 落点。同样是**无条件**的。 */
export interface LlmTarget {
  baseURL: string
  apiKey: string
  model: string
  visionModel: string
}

/**
 * @param wanted 用户选的模型（来自 profile）。会被夹进服务端白名单 ——
 *   传空或不认识时回落服务端默认模型。
 */
export function llmTarget(wanted: { model?: string; visionModel?: string } = {}): LlmTarget {
  const token = cloudToken()
  if (!token) throw new Error('尚未登录，请先在登录页登录账号')
  return {
    baseURL: cloudLLMBaseURL(),
    apiKey: token,
    model: clampModel('llm', wanted.model || ''),
    visionModel: clampModel('vision', wanted.visionModel || '')
  }
}

/* ------------------------------ 模型清单 ------------------------------ */

export interface ModelCatalog {
  llm: string[]
  asr: string[]
  defaults: { llm: string; vision: string }
  /** true = 这份清单是从服务端拉到的；false = 用的内置兜底清单（可能与服务端不一致） */
  live: boolean
}

/** 兜底清单：与网关 `LLM_ALLOWED_MODELS` / `ASR_ALLOWED_MODELS` 的默认值一致。 */
const FALLBACK_CATALOG: ModelCatalog = {
  llm: [...CLOUD_LLM_MODELS],
  asr: [...DASHSCOPE_MODELS],
  defaults: { llm: CLOUD_LLM_MODEL, vision: CLOUD_LLM_VISION_MODEL },
  live: false
}

let catalog: ModelCatalog | null = null

/**
 * 拉服务端实际放行的模型清单，并**缓存在主进程内存里**。
 *
 * 为什么必须缓存：`llmTarget()` 是同步的（在发请求的路径上被调用），
 * 而清单是异步拉的。缓存让"按用户选的模型发请求"这件事有可能同步完成。
 *
 * 拉不到就回落兜底清单 —— 兜底里的默认模型一定在网关白名单内，
 * 所以最坏情况是"用服务端默认模型"，与服务端自己的改写结果一致，不会更差。
 */
export async function loadModelCatalog(): Promise<ModelCatalog> {
  try {
    const body = (await callGateway('/api/models', { token: cloudToken(), timeoutMs: 8000 })) as {
      llm?: string[]
      asr?: string[]
      defaults?: { llm?: string; vision?: string }
    }
    const llm = Array.isArray(body.llm) && body.llm.length ? body.llm : FALLBACK_CATALOG.llm
    const asr = Array.isArray(body.asr) && body.asr.length ? body.asr : FALLBACK_CATALOG.asr
    catalog = {
      llm,
      asr,
      defaults: {
        llm: body.defaults?.llm || FALLBACK_CATALOG.defaults.llm,
        vision: body.defaults?.vision || FALLBACK_CATALOG.defaults.vision
      },
      live: true
    }
  } catch {
    // 网关旧版本没有 /api/models：静默回落，不打扰用户
    if (!catalog) catalog = FALLBACK_CATALOG
  }
  return catalog
}

export function modelCatalog(): ModelCatalog {
  return catalog ?? FALLBACK_CATALOG
}

/** 登出时丢掉，避免下次登录到另一台网关后还按旧清单夹模型 */
export function resetModelCatalog(): void {
  catalog = null
}

/* ------------------------- 套餐与购买方式（商店） ------------------------- */

export interface StorePlan {
  kind: string
  name: string
  plan: string
  days: number
  /** 元；null = 网关没配这个价格 */
  price: number | null
}

export interface StoreInfo {
  currency: string
  plans: StorePlan[]
  store: {
    purchaseUrl: string
    contactWechat: string
    contactQq: string
    contactEmail: string
    /** 购买说明，直接展示 */
    note: string
  }
  /** true = 来自服务端；false = 内置兜底（网关旧版本或不可达） */
  live: boolean
}

const EMPTY_STORE: StoreInfo = {
  currency: 'CNY',
  plans: [],
  store: { purchaseUrl: '', contactWechat: '', contactQq: '', contactEmail: '', note: '' },
  live: false
}

let storeCache: StoreInfo | null = null

/**
 * 拉套餐与购买方式并缓存在主进程内存里。
 *
 * 为什么价格和购买链接**必须来自服务端**：这两个东西一定会变（改价、换渠道、换客服微信），
 * 而客户端现在没有自动更新通道 —— 写死在客户端意味着改一次价格就要所有老用户手动重下。
 *
 * 这份信息是**公开**的（不含任何用户数据），所以登出时不需要清缓存。
 */
export async function loadStoreInfo(): Promise<StoreInfo> {
  try {
    const body = (await callGateway('/api/plans', { timeoutMs: 8000 })) as Partial<StoreInfo>
    storeCache = {
      currency: body.currency || 'CNY',
      plans: Array.isArray(body.plans) ? body.plans : [],
      store: { ...EMPTY_STORE.store, ...(body.store || {}) },
      live: true
    }
  } catch {
    // 网关不可达 / 旧版本没有这个接口：静默回落，界面显示"暂无购买渠道"而不是报错
    if (!storeCache) storeCache = EMPTY_STORE
  }
  return storeCache
}

export function storeInfo(): StoreInfo {
  return storeCache ?? EMPTY_STORE
}

/** 有没有可用的购买渠道。没有时界面要说清楚，而不是给一张空白卡片。 */
export function hasPurchaseChannel(info: StoreInfo = storeInfo()): boolean {
  const s = info.store
  return Boolean(s.purchaseUrl || s.contactWechat || s.contactQq || s.contactEmail)
}

/**
 * 把用户选的模型夹进服务端白名单。
 *
 * 不做这一步的后果不是报错，而是**静默换模型**：网关会把非白名单模型改写成它自己的
 * 默认值，用户看到的是"明明选了 glm-4-plus，回答却像 flash"。
 * 夹一下至少让客户端显示的、请求带的、服务端跑的三者一致。
 */
export function clampModel(kind: 'llm' | 'vision' | 'asr', wanted: string, mode?: 'realtime' | 'file'): string {
  const cat = modelCatalog()
  const pick = String(wanted || '').trim()

  if (kind === 'asr') {
    /**
     * ⚠️ 这里**先看模式、再看白名单**，顺序不能反。
     *
     * 白名单里同时有实时模型（`paraformer-realtime-v2`）和离线模型（`paraformer-v2`），
     * 所以"在白名单内"并不代表"能用在当前通道上"。只查白名单的话，
     * 把 `paraformer-v2` 发给实时端点会**连不上**（不是效果差，是直接失败），
     * 而错误信息只会说"任务失败"，用户完全猜不到是模型选错了。
     *
     * 传输方式（WebSocket 流式 / 整段上传）已经决定了模型族，所以这不是偏好而是约束。
     */
    const wantRealtime = mode !== 'file'
    const sameFamily = (m: string) => /realtime/.test(m) === wantRealtime
    if (pick && cat.asr.includes(pick) && sameFamily(pick)) return pick
    return cat.asr.find(sameFamily) || cat.asr[0] || pick
  }

  if (pick && cat.llm.includes(pick)) return pick
  return kind === 'vision' ? cat.defaults.vision : cat.defaults.llm
}

/* ------------------------------ 网关 API ------------------------------ */

/** 在途请求，退出时要能一起 abort（否则 will-quit 之后还有 socket 挂着） */
const inflight = new Set<AbortController>()

export function abortCloudRequests(): void {
  for (const c of inflight) {
    try {
      c.abort()
    } catch {
      /* noop */
    }
  }
  inflight.clear()
}

export class CloudError extends Error {
  constructor(
    message: string,
    /** 网关的 `reason`：客户端按它分支，**不要去匹配 message 文案** */
    readonly reason: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'CloudError'
  }
}

type GatewayBody = {
  ok?: boolean
  reason?: string
  message?: string
  token?: string
  me?: CloudQuota
  redeemed?: { plan: string; days: number; expiresAt: number; extended?: boolean }
  redeemWarning?: string
  sent?: boolean
  ttlMinutes?: number
  resendAfterMs?: number
  provider?: string
  retryAfterMs?: number
}

/**
 * 打网关。统一处理超时、abort、以及 `{ok:false,reason,message}` 这套错误信封。
 *
 * 超时是必须的：网关不可达时 fetch 默认会挂很久，用户看到的是"点了没反应"。
 */
async function callGateway(
  path: string,
  init: { method?: string; body?: unknown; token?: string; timeoutMs?: number } = {}
): Promise<GatewayBody> {
  const base = cloudBaseURL()

  const controller = new AbortController()
  inflight.add(controller)
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15000)
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {})
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal
    })
  } catch (err) {
    const e = err as Error
    if (e.name === 'AbortError') {
      throw new CloudError('连接网关超时，请检查网络与网关地址', 'timeout', 0)
    }
    throw new CloudError(`无法连接网关：${e.message}`, 'unreachable', 0)
  } finally {
    clearTimeout(timer)
    inflight.delete(controller)
  }

  let body: GatewayBody = {}
  try {
    body = (await res.json()) as GatewayBody
  } catch {
    // 网关前面挂了 nginx / 被 CDN 拦掉时返回的往往不是 JSON
    throw new CloudError(`网关返回了非 JSON 响应（HTTP ${res.status}）`, 'bad_response', res.status)
  }

  if (!res.ok || body.ok === false) {
    const reason = body.reason || 'unknown'
    const extra = body.retryAfterMs ? { retryAfterMs: body.retryAfterMs } : {}
    // 网关明确说"你没登录"时立刻清凭据 → 渲染层收到广播后自动回到登录页
    if (res.status === 401 && reason === 'unauthenticated') clearSession('token 已失效（unauthenticated）')
    throw Object.assign(
      new CloudError(body.message || `网关错误（HTTP ${res.status}）`, reason, res.status),
      extra
    )
  }
  return body
}

/* ------------------------------- 账号 ------------------------------- */

/** 把 token 与账号快照落盘。**token 只经由这里进入设置**，渲染层永远拿不到它。 */
function persistSession(token: string, me?: CloudQuota | null): CloudQuota | null {
  const s = getSettings()
  s.cloud.tokenEnc = encryptSecret(token)
  if (me) s.cloud.lastMe = me
  saveSettings(s)
  // 换了账号就是换了网关权限，旧清单立刻作废（下次用到时自然重拉）
  resetModelCatalog()
  return me ?? s.cloud.lastMe ?? null
}

/**
 * 登录入参。三种组合，与网关一一对应：
 *   - `{account, password}` / `{account: 手机号, password}`
 *   - `{phone, password}`
 *   - `{phone, smsCode}`
 *
 * ⚠️ 这里**不做任何字段校验**：手机号格式、必填组合都交给网关判断。
 * 客户端多一套校验规则，就多一处"两边不一致后用户被卡住"的地方
 * （而且客户端拦下来的错误没有网关写的文案清楚）。
 */
export interface LoginInput {
  account?: string
  phone?: string
  password?: string
  smsCode?: string
}

export async function login(input: LoginInput): Promise<CloudQuota | null> {
  const body = await callGateway('/api/auth/login', { method: 'POST', body: input })
  if (!body.token) throw new CloudError('网关未返回登录凭据', 'bad_response', 0)
  return persistSession(body.token, body.me ?? null)
}

/** 注册入参：`code` 是**邀请码/兑换码**，短信验证码是 `smsCode`（别混）。 */
export interface RegisterInput {
  account?: string
  phone?: string
  password: string
  smsCode?: string
  code?: string
}

export async function register(input: RegisterInput): Promise<{ me: CloudQuota | null; warning?: string }> {
  const body = await callGateway('/api/auth/register', { method: 'POST', body: input })
  if (!body.token) throw new CloudError('网关未返回登录凭据', 'bad_response', 0)
  const me = persistSession(body.token, body.me ?? null)
  return { me, warning: body.redeemWarning }
}

/**
 * 发短信验证码。
 *
 * 返回 `ttlMinutes` / `resendAfterMs` 让界面能显示倒计时与"重发"按钮的可用时间 ——
 * 否则用户只能对着一个点了没反应的按钮反复点，然后被 429 拦下来。
 */
export async function sendSmsCode(
  phone: string,
  purpose: 'login' | 'register'
): Promise<{ ttlMinutes: number; resendAfterMs: number; provider: string }> {
  const body = await callGateway('/api/auth/sms/send', { method: 'POST', body: { phone, purpose } })
  return {
    ttlMinutes: body.ttlMinutes ?? 5,
    resendAfterMs: body.resendAfterMs ?? 60000,
    provider: body.provider ?? 'unknown'
  }
}

export async function redeem(code: string): Promise<{ me: CloudQuota | null; message?: string }> {
  const body = await callGateway('/api/redeem', { method: 'POST', body: { code }, token: cloudToken() })
  // 兑换只改套餐，不动 token；但顺手同步一次快照
  const me = body.me ?? null
  if (me) {
    const s = getSettings()
    s.cloud.lastMe = me
    saveSettings(s)
  }
  return { me, message: body.message }
}

/**
 * 拉一次最新额度。
 *
 * **不做定期轮询**：额度是"消耗型"资源，只在登录、打开面板、发起提问、开始录音、
 * 兑换之后同步即可。常驻轮询只会给网关加无谓的负载。
 */
export async function refreshMe(): Promise<CloudQuota | null> {
  if (!cloudLoggedIn()) return null
  const body = await callGateway('/api/me', { token: cloudToken(), timeoutMs: 8000 })
  const me = body.me ?? null
  if (me) {
    const s = getSettings()
    s.cloud.lastMe = me
    saveSettings(s)
  }
  return me
}

/**
 * 登出：只清本地 token，不动套餐与用量（那是账号的属性，不是这台机器的）。
 *
 * 不需要额外去清 LLM 的 client 缓存：指纹里含 token 长度与尾 6 位
 * （见 `llm.ts` 的 `fingerprint`），换了 token 就不会命中旧连接。
 */
export function logout(): void {
  clearSession('用户主动登出')
}

/* ------------------------------ 连通性自检 ------------------------------ */

export interface GatewayPing {
  ok: boolean
  message: string
  /** 网关的短信通道是否就绪。登录页据此决定"获取验证码"能不能点。 */
  smsReady?: boolean
}

/**
 * 探活。
 *
 * 读 `/health` 而不是发一个必定 401 的请求：`/health` 顺带告诉我们**上游密钥配没配**、
 * **短信通道通不通**。这两件事决定了"登录页上哪些按钮点了会失败"，
 * 提前拿到就能把话说明白，而不是让用户去猜。
 */
export async function pingGateway(): Promise<GatewayPing> {
  const base = cloudBaseURL()
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) })
    const body = (await res.json().catch(() => ({}))) as {
      service?: string
      users?: number
      upstream?: { asr?: boolean; llm?: boolean }
      sms?: { provider?: string; ready?: boolean; hint?: string }
    }
    if (!res.ok) return { ok: false, message: `网关返回 HTTP ${res.status}` }
    const up = body.upstream ?? {}
    const missing = [!up.asr && '语音', !up.llm && '大模型'].filter(Boolean).join('、')
    const smsOk = body.sms?.ready !== false
    const notes = [
      missing ? `⚠️ 服务端未配置上游密钥：${missing}` : '',
      smsOk ? '' : `⚠️ 短信通道不可用（${body.sms?.provider ?? '?'}）：${body.sms?.hint ?? ''}`
    ].filter(Boolean)
    return {
      ok: true,
      smsReady: smsOk,
      message:
        `网关正常（${body.service ?? 'gateway'}，现有用户 ${body.users ?? '?'} 个）` +
        (notes.length ? `\n${notes.join('\n')}` : '')
    }
  } catch (err) {
    return { ok: false, message: `无法连接网关：${(err as Error).message}` }
  }
}
