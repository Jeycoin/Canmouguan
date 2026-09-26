'use strict'

/**
 * 网关配置。
 *
 * 设计原则：**零新增依赖** —— 不引 dotenv、不引 express、不引 jsonwebtoken。
 * 网关是唯一直接持有上游密钥的地方，依赖越少，供应链面越小；
 * 而且它要被丢到一台便宜 VPS 上长期跑，能少装一个包就少一个。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const SERVER_DIR = path.join(__dirname, '..')

/**
 * 极简 .env 加载器。
 * 已存在的真实环境变量**优先**（部署时用 systemd 注入的变量不会被文件覆盖）。
 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadDotEnv(path.join(SERVER_DIR, '.env'))

const DATA_DIR = process.env.CMG_DATA_DIR || path.join(SERVER_DIR, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

/**
 * 签名密钥：用于签发/校验客户端 token。
 *
 * 不写死、不入库、打印一次就够。**自动生成并落盘**，这样重启后已发的 token 仍然有效
 * （否则每次重启把所有用户踢下线，体验很差）。
 * 也可以由部署环境用 CMG_GATEWAY_SECRET 覆盖 —— 多实例部署时必须显式设置同一个值。
 */
const SECRET_FILE = path.join(DATA_DIR, 'gateway.secret')
function loadOrCreateSecret() {
  const fromEnv = process.env.CMG_GATEWAY_SECRET
  if (fromEnv) return fromEnv
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const saved = fs.readFileSync(SECRET_FILE, 'utf8').trim()
      if (saved) return saved
    }
  } catch {
    /* 读失败就重新生成 */
  }
  const secret = crypto.randomBytes(48).toString('base64url')
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 })
  return secret
}

/**
 * 套餐定义。
 *
 * ⚠️ **这里没有免费套餐** —— 产品形态是纯付费：注册只给一个账号，不给任何额度。
 * 额度的唯一来源是兑换码（见 `REDEEM_PLANS`）。所以"未开通 / 已到期"的用户
 * 落到的是 0 额度的占位套餐 `none`，而不是一段可以白用的额度。
 *
 * ⚠️ pro 的额度直接决定毛利，改之前先算成本（见 server/README.md 的成本表）：
 *   - realtime ASR ¥0.864/小时，file ASR ¥0.288/小时
 *   - **双通道同时采集 ⇒ 一场 1 小时面试消耗 2 小时 ASR 额度、成本约 ¥1.15**
 *   - 所以 pro 给 20 小时 ASR 额度 ≈ 10 场面试 ≈ ¥11.5 硬成本
 *
 * 用环境变量可覆盖单个数值，**不用改代码重新部署**。
 */
function num(name, fallback) {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/** 售价允许为 0（做活动白送），所以不能用上面的 num() —— 它把 0 当成"没设" */
function price(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const v = Number(raw)
  return Number.isFinite(v) && v >= 0 ? v : fallback
}

/** `a=b,c=d` → `{a:'b', c:'d'}`。键值任一为空就跳过，不因为一个笔误整块失效。 */
function parseSkuMap(raw) {
  const out = {}
  for (const pair of String(raw || '').split(',')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const key = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (key && value) out[key] = value
  }
  return out
}

const PLANS = {
  /**
   * 占位套餐：**未开通 或 已到期**的账号落在这里，额度恒为 0。
   *
   * 它不是为了"限制"而存在（0 额度本身就限制了），而是为了让 `entitlement()`
   * 在任何输入下都能返回一个合法的 plan 对象 —— 否则每个调用点都要处理 `undefined`，
   * 那种散落的判空迟早会漏一处，而漏掉的那处就是"没买也能用"。
   *
   * ⚠️ 给用户的解释**不在这个对象里**（它只有 name），而在 `quota.js` 的提示文案里 ——
   * 那些文案要区分"从没开通过"和"开通了但已到期"，只有 quota 拿得到 user。
   */
  none: {
    id: 'none',
    name: '未开通',
    /** none = 没有计费周期；额度永远不重置，因为额度就是 0 */
    period: 'none',
    asrSeconds: 0,
    llmCalls: 0,
    concurrentRealtime: 0
  },
  pro: {
    id: 'pro',
    name: '专业版',
    /** monthly = 每月重置 */
    period: 'monthly',
    asrSeconds: num('CMG_PRO_ASR_SECONDS', 72000), // 20 小时
    llmCalls: num('CMG_PRO_LLM_CALLS', 2000),
    concurrentRealtime: 2
  }
}

/**
 * 兑换码能换到的套餐与天数。
 *
 * ⚠️ **这里是"卖什么"的唯一真相来源**：`/api/plans` 直接遍历它生成价目表，
 * `payhook` 也用它判断平台传来的 SKU 合不合法。
 * 加一档只改这里 + `STORE_PRICES`，客户端一行都不用动。
 *
 * 天数刻意用 31/93/366 而不是"自然月"：兑换码发的是**天数**，
 * 按自然月算会让"1 月 31 日买的月卡"在 2 月缩水成 28 天，解释成本比省下的几天高得多。
 */
const REDEEM_PLANS = {
  month: { plan: 'pro', days: 31, name: '专业版 1 个月' },
  quarter: { plan: 'pro', days: 93, name: '专业版 3 个月' },
  year: { plan: 'pro', days: 366, name: '专业版 1 年' }
}

const DASHSCOPE_HTTP = process.env.CMG_DASHSCOPE_HTTP || 'https://dashscope.aliyuncs.com'

module.exports = {
  SERVER_DIR,
  DATA_DIR,
  DB_PATH: process.env.CMG_DB_PATH || path.join(DATA_DIR, 'gateway.db'),
  PORT: Number(process.env.CMG_PORT) || 8787,
  HOST: process.env.CMG_HOST || '127.0.0.1',
  GATEWAY_SECRET: loadOrCreateSecret(),
  /** token 有效期（默认 30 天）；客户端到期前会自动重新登录 */
  TOKEN_TTL_MS: num('CMG_TOKEN_TTL_DAYS', 30) * 86400000,

  PLANS,
  REDEEM_PLANS,
  /**
   * 是否允许自助注册。
   * 做内测时建议设成 0：只让拿到兑换码的人进来，避免陌生人注册占配额。
   */
  ALLOW_SELF_REGISTER: process.env.CMG_ALLOW_SELF_REGISTER !== '0',
  /** 注册时可选的邀请码（设了就必须填） */
  REGISTER_INVITE_CODE: process.env.CMG_REGISTER_INVITE_CODE || '',

  /* ----------------------------- 上游凭据 ----------------------------- */
  /** 百炼（语音）：实时 WS 与 HTTP 同 Key */
  DASHSCOPE_API_KEY: process.env.CMG_DASHSCOPE_API_KEY || '',
  DASHSCOPE_HTTP,
  DASHSCOPE_WS: process.env.CMG_DASHSCOPE_WS || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/',
  /** 语音模型：客户端可以传 model，但**只允许白名单内的**，避免被拿来跑别的模型 */
  ASR_ALLOWED_MODELS: (
    process.env.CMG_ASR_MODELS ||
    'paraformer-realtime-v2,paraformer-realtime-v1,paraformer-realtime-8k-v2,paraformer-v2,paraformer-8k-v2,sensevoice-v1'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** 大模型：OpenAI 兼容端点 + Key */
  LLM_API_KEY: process.env.CMG_LLM_API_KEY || '',
  LLM_BASE_URL: process.env.CMG_LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
  /** 默认模型；客户端可传，但同样走白名单 */
  LLM_MODEL: process.env.CMG_LLM_MODEL || 'glm-4-flash',
  LLM_VISION_MODEL: process.env.CMG_LLM_VISION_MODEL || 'glm-4v-flash',
  LLM_ALLOWED_MODELS: (
    process.env.CMG_LLM_MODELS || 'glm-4-flash,glm-4v-flash,glm-4-plus,glm-4-air,glm-4v,glm-4'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** 单次文件转写的请求体上限（默认 20MB ≈ 10 分钟 16k 单声道 PCM16） */
  MAX_UPLOAD_BYTES: num('CMG_MAX_UPLOAD_BYTES', 20 * 1024 * 1024),

  /* --------------------------- 短信（手机号登录） --------------------------- */
  /**
   * 本机部署没有短信通道，默认走 `console`：验证码直接打进网关日志，够自测。
   *
   * ⚠️ **生产环境（NODE_ENV=production）下 console 通道会被自动拒绝** ——
   * 把登录验证码打进日志，等于把任意账号交给任何能看到日志的人（日志还会被转发、
   * 归档、发给第三方排障）。要放行必须显式设 `CMG_SMS_ALLOW_CONSOLE=1`。
   *
   * 接真实短信服务用 `webhook`：网关把 {phone, code, purpose, expiresInMinutes}
   * POST 给 CMG_SMS_WEBHOOK_URL，由那边的适配器去调阿里云/腾讯云短信。
   * 这样换服务商不用改网关，也不用在这里堆各家 SDK。
   */
  SMS: {
    provider: (process.env.CMG_SMS_PROVIDER || 'console').trim().toLowerCase(),
    webhookUrl: process.env.CMG_SMS_WEBHOOK_URL || '',
    webhookToken: process.env.CMG_SMS_WEBHOOK_TOKEN || '',
    allowConsole: process.env.CMG_SMS_ALLOW_CONSOLE === '1',
    isProduction: process.env.NODE_ENV === 'production',
    /** 验证码有效期（分钟） */
    ttlMinutes: num('CMG_SMS_TTL_MINUTES', 5),
    /** 同一个码最多试错几次 —— 6 位数字必须配这个，否则可以慢慢枚举 */
    maxAttempts: num('CMG_SMS_MAX_ATTEMPTS', 5),
    /** 同一手机号两次下发之间的最短间隔（秒） */
    resendSeconds: num('CMG_SMS_RESEND_SECONDS', 60),
    /** 同一手机号每小时最多下发几条（短信是要花钱的，这是成本闸门） */
    perHour: num('CMG_SMS_PER_HOUR', 5),
    /** 同一 IP 每小时最多下发几条（防脚本批量刷不同号码） */
    perHourPerIp: num('CMG_SMS_PER_HOUR_IP', 20)
  },

  /* --------------------- 商店信息（购买指引，服务端下发） ---------------------
   * 这些值**必须由服务端下发**，不能让客户端写死：改价格、换购买链接、换客服微信
   * 都不该逼用户重新下载客户端（何况现在还没有自动更新通道）。
   */
  STORE: {
    purchaseUrl: process.env.CMG_STORE_URL || '',
    contactWechat: process.env.CMG_STORE_WECHAT || '',
    contactQq: process.env.CMG_STORE_QQ || '',
    contactEmail: process.env.CMG_STORE_EMAIL || '',
    /** 购买说明，直接展示给用户（例如"拍下后备注手机号，5 分钟内发码"） */
    note: process.env.CMG_STORE_NOTE || ''
  },

  /**
   * 各套餐售价（元）。仅用于**展示**，网关不参与收款。
   * 允许为 0（例如做活动白送一批），所以下面用的是 price() 而不是 num()。
   */
  STORE_PRICES: {
    month: price('CMG_PRICE_MONTH', 49),
    quarter: price('CMG_PRICE_QUARTER', 129),
    year: price('CMG_PRICE_YEAR', 399)
  },

  /* --------------------- 发卡平台回调（自动发码） ---------------------
   * 收银台放在发卡平台，网关只负责"收到付款通知 → 现场签发兑换码 → 返回给平台展示"。
   *
   * ⚠️ **默认关闭**（token 为空即关闭）。这个端点能在没有任何账号的情况下凭空发会员，
   * 一旦裸奔等于把"免费领会员"开放给全网。必须显式配了 token 才生效。
   */
  PAYHOOK: {
    token: process.env.CMG_PAYHOOK_TOKEN || '',
    /**
     * 平台商品 ID → 兑换码类型 的映射，形如 `sku-abc123=month,sku-def456=year`。
     * 让平台商品改名只改配置，不用动代码。
     * 若平台直接把 `month` 这类类型当商品 ID 传（常见），不配也能用 —— 见 resolveKind()。
     */
    products: parseSkuMap(process.env.CMG_PAYHOOK_PRODUCTS || ''),
    /** 单次回调最多签发几个码，防止伪造请求一次薅走一大批会员 */
    maxCount: num('CMG_PAYHOOK_MAX_COUNT', 20)
  }
}
