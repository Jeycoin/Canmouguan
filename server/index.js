'use strict'

/**
 * 「参谋官」云端网关。
 *
 * 职责：**把上游 API 密钥关在这台机器里**，对外只发账号与额度。
 *   - 账号 / 配额 / 兑换码  → 自己实现（SQLite）
 *   - LLM（SSE）           → /v1/chat/completions        透传
 *   - 文件转写（HTTP）      → /v1/audio/transcriptions    透传
 *   - 实时转写（WS）        → /v1/asr/realtime            双向透传 + 计量
 *
 * 客户端只改两处：`baseURL` 指向本服务、`apiKey` 换成登录 token。
 * 上游协议刻意不做任何改写，所以上游升级时网关通常不用动。
 */

/* node:sqlite 目前是实验特性，启动会打一行 ExperimentalWarning。
   网关每次重启都刷这行会淹没真正的日志，这里定向过滤掉（只滤这一条）。 */
const originalEmitWarning = process.emitWarning
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : warning && warning.message
  if (typeof text === 'string' && text.includes('SQLite is an experimental feature')) return
  return originalEmitWarning.call(process, warning, ...rest)
}

const http = require('node:http')
const env = require('./lib/env')
const { PORT, HOST, ALLOW_SELF_REGISTER, REGISTER_INVITE_CODE, PLANS } = require('./lib/env')
const { ok, fail, readJson, rateLimit, clientIp, applyCors } = require('./lib/http')
const { hashPassword, verifyPassword, issueToken, authenticate } = require('./lib/auth')
const quota = require('./lib/quota')
const redeem = require('./lib/redeem')
const sms = require('./lib/sms')
const payhook = require('./lib/payhook')
const db = require('./lib/db')
const { handleChatCompletions } = require('./lib/relay-llm')
const { handleTranscriptions, handleRealtimeUpgrade } = require('./lib/relay-asr')

const ACCOUNT_RE = /^[A-Za-z0-9_.@+-]{3,64}$/
const MIN_PASSWORD = 6
/** 手机号只收大陆号段：网关部署在国内，其它号段既发不出短信也无从验证 */
const PHONE_RE = /^1[3-9]\d{9}$/

/**
 * 手机号既可能是账号本身（注册时不填 account），也可能是账号的绑定属性，
 * 所以"找用户"要两处都查 —— 而且账号字段填的是手机号时也该能登录。
 */
function findUserByIdentifier(account, phone) {
  if (account) {
    const byAccount = db.userByAccount(account)
    if (byAccount) return byAccount
  }
  const candidate = phone || (PHONE_RE.test(account) ? account : '')
  return candidate ? db.userByPhone(candidate) : null
}

/**
 * 事件日志里对身份做脱敏。
 * events 表会被导出、被贴进排障对话，手机号与邮箱不该以明文躺在那里。
 */
function maskIdentity(value) {
  const s = String(value || '')
  if (PHONE_RE.test(s)) return `${s.slice(0, 3)}****${s.slice(-4)}`
  const at = s.indexOf('@')
  if (at > 0) return `${s.slice(0, 1)}***${s.slice(at)}`
  return s
}

/* ------------------------------ 账号路由 ------------------------------ */

/**
 * 注册。两条路：
 *   - `{ account, password, code? }`      账号 + 密码（原路径）
 *   - `{ phone, smsCode, password, account? }` 手机号 + 短信验证码（account 省略时手机号即账号）
 * 两条路共用的部分是"注册控制（邀请码/自助开关）"与"注册后的开通"，所以提到前面统一做。
 */
async function routeRegister(req, res) {
  const ip = clientIp(req)
  const limited = rateLimit(`reg:${ip}`, 10, 3600000)
  if (!limited.ok) return fail(res, 429, 'rate_limited', '注册过于频繁，请稍后再试')

  let body
  try {
    body = await readJson(req)
  } catch {
    return fail(res, 400, 'invalid_json', '请求体不是合法 JSON')
  }

  // 注意字段名：这里的 code 是**邀请码/兑换码**，短信验证码是 smsCode。
  // 两者都会出现在注册请求里，混用会让"码不对"变成无法定位的故障。
  const invite = String(body.code || body.inviteCode || '').trim()

  // 白名单式的注册控制：内测阶段只让"有码的人"进来，避免陌生人占额度
  if (REGISTER_INVITE_CODE && invite.toUpperCase() !== REGISTER_INVITE_CODE.toUpperCase()) {
    return fail(res, 403, 'invite_required', '需要内测邀请码')
  }
  if (!ALLOW_SELF_REGISTER && !invite) {
    return fail(res, 403, 'register_closed', '暂未开放自助注册，请使用兑换码开通')
  }

  const phone = String(body.phone || '').trim()
  const password = String(body.password || '')

  if (phone) {
    return registerWithPhone(res, {
      ip,
      phone,
      smsCode: String(body.smsCode || '').trim(),
      account: String(body.account || '').trim(),
      password,
      invite
    })
  }

  const account = String(body.account || '').trim()
  if (!ACCOUNT_RE.test(account)) {
    return fail(res, 400, 'invalid_account', '账号需为 3–64 位字母、数字或 _ . @ + - 组成')
  }
  if (password.length < MIN_PASSWORD) {
    return fail(res, 400, 'weak_password', `密码至少 ${MIN_PASSWORD} 位`)
  }
  if (db.userByAccount(account)) {
    // 注册接口本来就会暴露"账号是否已存在"，这里用中性文案但仍给出明确指引
    return fail(res, 409, 'account_taken', '该账号已被注册，请直接登录或换一个')
  }

  const { hash, salt } = hashPassword(password)
  const user = db.createUser({ account, passHash: hash, passSalt: salt })
  return finishRegister(res, user, invite, ip, 'register')
}

function registerWithPhone(res, { ip, phone, smsCode, account, password, invite }) {
  if (!PHONE_RE.test(phone)) return fail(res, 400, 'invalid_phone', '请输入 11 位大陆手机号')
  // 密码是必填的：这样"每个账号都有密码"这条不变量不被破坏，
  // 也免得 pass_hash 变成可空列（那会让登录路径多出一堆 null 分支）。
  if (password.length < MIN_PASSWORD) {
    return fail(res, 400, 'weak_password', `请设置至少 ${MIN_PASSWORD} 位密码，之后可用密码或验证码登录`)
  }
  if (db.userByPhone(phone)) {
    return fail(res, 409, 'phone_taken', '该手机号已注册，请直接登录')
  }
  const login = account || phone
  if (account && !ACCOUNT_RE.test(account)) {
    return fail(res, 400, 'invalid_account', '账号需为 3–64 位字母、数字或 _ . @ + - 组成')
  }
  if (db.userByAccount(login)) {
    return fail(res, 409, 'account_taken', '该账号已被注册，请直接登录或换一个')
  }

  /* 验码放在最后：前面任何一步失败都会 return，不会消耗掉用户刚收到的验证码。
     （验码成功即作废，先验的话用户少填一个字段就白等一条短信。） */
  const verified = sms.verifyCode(phone, 'register', smsCode)
  if (!verified.ok) return fail(res, 400, verified.reason, verified.message)

  const { hash, salt } = hashPassword(password)
  const user = db.createUser({ account: login, phone, passHash: hash, passSalt: salt })
  return finishRegister(res, user, invite, ip, 'register_phone')
}

/** 注册收尾：记事件 + 带码开通 + 发 token。两条注册路径共用。 */
function finishRegister(res, user, invite, ip, kind) {
  db.logEvent(kind, user.id, `ip=${ip}`)

  // 注册时带码：直接开通，省掉"注册完再兑一次"的来回
  let redeemed = null
  if (invite) {
    const result = redeem.redeem(user, invite)
    if (result.ok) redeemed = { plan: result.plan, days: result.days, expiresAt: result.expiresAt }
    else db.logEvent('register_code_failed', user.id, `${invite} ${result.reason}`)
  }

  const fresh = db.userById(user.id)
  return ok(res, {
    token: issueToken(user.id),
    me: quota.snapshot(fresh),
    redeemed,
    // 带码失败要说清楚，否则用户以为已经开通了
    redeemWarning: invite && !redeemed ? '兑换码未能生效，可在登录后重新兑换' : undefined
  })
}

/**
 * 发短信验证码。
 * `purpose=register` 时先查重：省掉一条注定失败的短信（短信是要花钱的）。
 * `purpose=login` 刻意**不查**：那会让任何人拿手机号来探测"哪些号注册过"。
 * 登录时号不存在也不浪费 —— 只有号主本人能拿到码并用它换到那个明确的提示。
 */
async function routeSmsSend(req, res) {
  const ip = clientIp(req)
  let body
  try {
    body = await readJson(req)
  } catch {
    return fail(res, 400, 'invalid_json', '请求体不是合法 JSON')
  }

  const phone = String(body.phone || '').trim()
  const purpose = String(body.purpose || 'login').trim() === 'register' ? 'register' : 'login'
  if (!PHONE_RE.test(phone)) return fail(res, 400, 'invalid_phone', '请输入 11 位大陆手机号')

  if (purpose === 'register' && db.userByPhone(phone)) {
    return fail(res, 409, 'phone_taken', '该手机号已注册，请直接登录')
  }

  const info = sms.providerInfo()
  if (!info.ready) {
    // 503 而不是 500：这是"服务未就绪"，运维配好通道就能用，代码没有 bug
    return fail(res, 503, 'sms_not_configured', info.hint)
  }

  // 冷却基于"上一条码的发送时间"，所以发送失败时不会白等
  const wait = sms.cooldownRemainingMs(phone, purpose)
  if (wait > 0) {
    return fail(res, 429, 'too_soon', `请求过于频繁，请 ${Math.ceil(wait / 1000)} 秒后重试`, {
      retryAfterMs: wait
    })
  }

  // 按号码与按 IP 各限一层：只限号码挡不住换号刷，只限 IP 挡不住分布式换 IP
  const byPhone = rateLimit(`sms:phone:${phone}`, sms.config.perHour, 3600000)
  const byIp = rateLimit(`sms:ip:${ip}`, sms.config.perHourPerIp, 3600000)
  if (!byPhone.ok || !byIp.ok) {
    return fail(res, 429, 'rate_limited', '验证码发送次数过多，请稍后再试')
  }

  try {
    const sent = await sms.issueCode(phone, purpose)
    db.logEvent('sms_send', null, `${purpose} ${maskIdentity(phone)} ip=${ip}`)
    return ok(res, {
      sent: true,
      purpose,
      ttlMinutes: sent.ttlMinutes,
      resendAfterMs: sms.config.resendSeconds * 1000,
      provider: sent.provider
    })
  } catch (err) {
    const reason = (err && err.reason) || 'sms_failed'
    db.logEvent('sms_send_failed', null, `${purpose} ${maskIdentity(phone)} ${reason}`)
    console.error('[gateway] 短信发送失败', maskIdentity(phone), reason, (err && err.message) || '')
    return fail(res, 502, reason, (err && err.message) || '短信发送失败，请稍后重试')
  }
}

/**
 * 登录。支持三种组合：
 *   - `{ account, password }` / `{ account: 手机号, password }`
 *   - `{ phone, password }`
 *   - `{ phone, smsCode }` / `{ account: 手机号, smsCode }`
 */
async function routeLogin(req, res) {
  const ip = clientIp(req)
  let body
  try {
    body = await readJson(req)
  } catch {
    return fail(res, 400, 'invalid_json', '请求体不是合法 JSON')
  }
  const account = String(body.account || '').trim()
  const phone = String(body.phone || '').trim()
  const password = String(body.password || '')
  const smsCode = String(body.smsCode || '').trim()
  const identifier = account || phone

  if (!identifier) return fail(res, 400, 'account_required', '请输入账号或手机号')
  if (phone && !PHONE_RE.test(phone)) return fail(res, 400, 'invalid_phone', '请输入 11 位大陆手机号')

  // 按 IP 与按账号各限一层：只限 IP 挡不住分布式撞库，只限账号挡不住广撒网
  const byIp = rateLimit(`login:ip:${ip}`, 30, 900000)
  const byAccount = rateLimit(`login:acc:${identifier}`, 10, 900000)
  if (!byIp.ok || !byAccount.ok) {
    return fail(res, 429, 'rate_limited', '登录尝试过于频繁，请 15 分钟后再试')
  }

  const user = findUserByIdentifier(account, phone)
  let how = 'password'

  if (smsCode) {
    how = 'sms'
    const target = phone || account
    if (!PHONE_RE.test(target)) return fail(res, 400, 'invalid_phone', '请输入 11 位大陆手机号')

    /* 先验码、再判"号是否注册过"：验码成功等于证明对方持有该手机号，
       所以此处的"未注册"提示不会变成账号枚举通道。 */
    const verified = sms.verifyCode(target, 'login', smsCode)
    if (!verified.ok) {
      db.logEvent('login_sms_failed', user ? user.id : null, `${maskIdentity(target)} ${verified.reason}`)
      return fail(res, 401, verified.reason, verified.message)
    }
    if (!user) return fail(res, 401, 'phone_not_registered', '该手机号尚未注册，请先注册后再登录')
  } else {
    // 账号不存在与密码错误返回同一个 reason，避免被拿来枚举账号
    if (!user || !verifyPassword(password, user.pass_hash, user.pass_salt)) {
      db.logEvent('login_failed', user ? user.id : null, `account=${maskIdentity(identifier)}`)
      return fail(res, 401, 'bad_credentials', '账号或密码不正确')
    }
  }

  if (user.disabled) return fail(res, 403, 'account_disabled', '账号已被停用，请联系客服')

  db.touchLogin(user.id)
  db.logEvent('login', user.id, `ip=${ip} how=${how}`)
  return ok(res, { token: issueToken(user.id), me: quota.snapshot(user) })
}

async function routeMe(req, res, ctx) {
  return ok(res, { me: quota.snapshot(ctx.user) })
}

async function routeRedeem(req, res, ctx) {
  const ip = clientIp(req)
  const limited = rateLimit(`redeem:${ctx.user.id}`, 10, 3600000)
  if (!limited.ok) return fail(res, 429, 'rate_limited', '兑换尝试过于频繁，请稍后再试')

  let body
  try {
    body = await readJson(req)
  } catch {
    return fail(res, 400, 'invalid_json', '请求体不是合法 JSON')
  }
  const code = String(body.code || '').trim()
  if (!code) return fail(res, 400, 'code_required', '请输入兑换码')

  const result = redeem.redeem(ctx.user, code)
  if (!result.ok) {
    db.logEvent('redeem_failed', ctx.user.id, `${code} ${result.reason}`)
    // 兑换码错误是用户能自己修的，用 400 而不是 500
    return fail(res, 400, result.reason, result.message)
  }
  const fresh = db.userById(ctx.user.id)
  return ok(res, {
    me: quota.snapshot(fresh),
    redeemed: { plan: result.plan, days: result.days, expiresAt: result.expiresAt, extended: result.extended },
    message: result.extended
      ? `已续期 ${result.days} 天，会员有效期延长至 ${new Date(result.expiresAt).toLocaleDateString('zh-CN')}`
      : `已开通 ${PLANS[result.plan]?.name || result.plan} ${result.days} 天`
  })
}

/* ------------------------------- 路由表 ------------------------------- */

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  applyCors(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  if (path === '/health') {
    const smsInfo = sms.providerInfo()
    const hookInfo = payhook.info()
    return ok(res, {
      service: 'canmouguan-gateway',
      users: db.countUsers(),
      upstream: {
        asr: Boolean(env.DASHSCOPE_API_KEY),
        llm: Boolean(env.LLM_API_KEY)
      },
      /* 短信通道状态放在这里：用户报"收不到验证码"时，
         第一件事就是打 /health 看通道是否就绪，而不用去翻服务端日志。 */
      sms: { provider: smsInfo.name, ready: smsInfo.ready, hint: smsInfo.hint },
      /* 发卡回调同理：用户报"付了钱没拿到码"时先看这一行 —— 最常见的原因是压根没开 */
      payhook: { enabled: hookInfo.enabled, hint: hookInfo.hint }
    })
  }

  /** 需要登录的接口统一在这里取身份，避免每个 handler 重复写一遍 */
  const requireAuth = () => {
    const ctx = authenticate(req, url)
    if (!ctx) {
      fail(res, 401, 'unauthenticated', '登录已过期，请重新登录')
      return null
    }
    return ctx
  }

  try {
    if (path === '/api/auth/register' && req.method === 'POST') return await routeRegister(req, res)
    if (path === '/api/auth/login' && req.method === 'POST') return await routeLogin(req, res)
    if (path === '/api/auth/sms/send' && req.method === 'POST') return await routeSmsSend(req, res)

    /* 发卡平台回调。**不是给客户端用的**，所以走另一套鉴权（平台 token，见 payhook.js）。
       放在 requireAuth 之前是因为调用方是平台服务器，它没有也不该有用户 token。 */
    if (path === '/api/hook/card' && req.method === 'POST') {
      return await payhook.handlePayhook(req, res, url)
    }

    /**
     * 套餐与购买方式。**刻意不要求登录**：
     * 用户是先买码、再注册的 —— 让他先登录才能看到价格，等于把最大的那部分人挡在门外。
     * 服务端下发而不是客户端写死，是为了改价格/换购买链接不用重新打包客户端。
     */
    if (path === '/api/plans') {
      return ok(res, {
        currency: 'CNY',
        /**
         * 价格与可用时长**同源于 REDEEM_PLANS**，不给第二个真相来源 ——
         * 两处各写一份迟早会出现"标价 1 个月、实际发 7 天"。
         */
        plans: Object.entries(env.REDEEM_PLANS).map(([kind, spec]) => ({
          kind,
          name: spec.name,
          plan: spec.plan,
          days: spec.days,
          price: env.STORE_PRICES[kind] ?? null
        })),
        store: {
          purchaseUrl: env.STORE.purchaseUrl,
          contactWechat: env.STORE.contactWechat,
          contactQq: env.STORE.contactQq,
          contactEmail: env.STORE.contactEmail,
          note: env.STORE.note
        }
      })
    }

    if (path === '/api/me') {
      const ctx = requireAuth()
      return ctx ? await routeMe(req, res, ctx) : undefined
    }
    if (path === '/api/redeem' && req.method === 'POST') {
      const ctx = requireAuth()
      return ctx ? await routeRedeem(req, res, ctx) : undefined
    }
    if (path === '/api/usage') {
      const ctx = requireAuth()
      if (!ctx) return undefined
      const ent = quota.entitlement(ctx.user)
      return ok(res, {
        period: ent.period,
        asr: ent.asr,
        llm: ent.llm,
        recent: db.recentEvents(30).filter((e) => e.user_id === ctx.user.id)
      })
    }

    /**
     * 服务端**实际**放行的模型清单。
     *
     * 为什么必须有这个接口：网关对非白名单模型是**静默改写**成默认模型（防用贵模型刷额度），
     * 所以客户端如果自己维护一份列表，就会出现"下拉里选的是 A、实际跑的是 B"，
     * 而且不报错 —— 用户只会觉得"这软件怎么忽好忽坏"。
     * 让客户端来问，两边就不可能不一致。
     */
    if (path === '/api/models') {
      const ctx = requireAuth()
      if (!ctx) return undefined
      return ok(res, {
        llm: env.LLM_ALLOWED_MODELS,
        asr: env.ASR_ALLOWED_MODELS,
        defaults: { llm: env.LLM_MODEL, vision: env.LLM_VISION_MODEL }
      })
    }

    /* --------------------------- 上游代理 --------------------------- */
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      const ctx = requireAuth()
      return ctx ? await handleChatCompletions(req, res, ctx) : undefined
    }
    if (path === '/v1/audio/transcriptions' && req.method === 'POST') {
      const ctx = requireAuth()
      return ctx ? await handleTranscriptions(req, res, ctx) : undefined
    }

    return fail(res, 404, 'not_found', `未知接口：${req.method} ${path}`)
  } catch (err) {
    console.error('[gateway] 未捕获异常', path, err)
    db.logEvent('unhandled_error', null, `${path} ${err && err.message}`)
    if (!res.headersSent) return fail(res, 500, 'internal_error', '服务内部错误')
    try {
      res.end()
    } catch {
      /* noop */
    }
  }
}

const server = http.createServer(handle)

server.on('upgrade', (req, socket, head) => {
  let url
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  } catch {
    socket.destroy()
    return
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (path === '/v1/asr/realtime') {
    console.log('[gateway] 实时转写连接建立')
    return handleRealtimeUpgrade(req, socket, head, url)
  }
  socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
  socket.destroy()
})

server.listen(PORT, HOST, () => {
  console.log(`[gateway] 监听 http://${HOST}:${PORT}`)
  console.log(`[gateway] 数据库 ${env.DB_PATH}`)
  console.log(`[gateway] 语音上游 ${env.DASHSCOPE_API_KEY ? '已配置' : '❌ 未配置（CMG_DASHSCOPE_API_KEY）'}`)
  console.log(`[gateway] 大模型上游 ${env.LLM_API_KEY ? '已配置' : '❌ 未配置（CMG_LLM_API_KEY）'}`)
  console.log(`[gateway] 自助注册 ${ALLOW_SELF_REGISTER ? '开启' : '关闭'}${REGISTER_INVITE_CODE ? '（需邀请码）' : ''}`)
  /* 短信通道在启动时就得说清楚：不然"点发送验证码没反应"要等到有人注册才发现。 */
  const smsInfo = sms.providerInfo()
  console.log(
    `[gateway] 短信通道 ${smsInfo.ready ? '' : '❌ '}${smsInfo.name} —— ${smsInfo.hint}`
  )
  /* 发卡回调同理。它默认是关的，而"关闭"的表现是平台侧回调 503 ——
     不在启动日志里说出来，就会变成"用户付了钱、码没发出去"这种最难查的问题。 */
  const hookInfo = payhook.info()
  console.log(`[gateway] 发卡回调 ${hookInfo.enabled ? '' : '（未开启）'}—— ${hookInfo.hint}`)
  if (!env.STORE.purchaseUrl && !env.STORE.contactWechat && !env.STORE.contactQq && !env.STORE.contactEmail) {
    console.log('[gateway] ⚠️ 未配置购买方式（CMG_STORE_URL / CMG_STORE_WECHAT …）—— 客户端会显示"暂无购买渠道"')
  }
  console.log(`[gateway] 现有用户 ${db.countUsers()} 个`)
})

/* 优雅退出：SQLite 是同步 API，正常关掉即可；
   真正的目的是让 Ctrl+C 后端口立刻释放，不用等 TIME_WAIT。 */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[gateway] 收到 ${sig}，正在关闭…`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
