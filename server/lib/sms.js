'use strict'

/**
 * 短信验证码：**发送通道**（provider）与**签发/校验策略**。
 *
 * 为什么把这两件事放在一个文件里：策略（有效期、错几次作废、多久能重发）和通道
 * 是同一件事的两面 —— 换短信服务商只换 provider，策略一行不用动；反过来调策略
 * 也不该去碰 HTTP 调用。真正的传输细节（URL/鉴权/超时）都在 provider 里。
 *
 * ⚠️ 本层的核心纪律：**发不出去就不留痕迹**。
 * 顺序必须是「先发、后落库」，而不是「先落库、再发」。反过来的话，用户看到
 * "已发送"却收不到短信，而库里躺着一条 5 分钟内有效的码 —— 用户会一直重试，
 * 日志上全是 429，没人看得出根因是通道挂了。
 */

const crypto = require('node:crypto')
const { GATEWAY_SECRET, SMS } = require('./env')
const db = require('./db')

/* ------------------------------ 通道状态 ------------------------------ */

/**
 * 通道是否可用 —— 给 `/health` 与启动横幅用。
 * 刻意做成"不抛异常、返回状态"，因为要在启动时就把问题喊出来，
 * 而不是等第一个用户点了"发送验证码"才发现。
 */
function providerInfo() {
  if (SMS.provider === 'console') {
    const blocked = SMS.isProduction && !SMS.allowConsole
    return {
      name: 'console',
      ready: !blocked,
      blocked,
      hint: blocked
        ? '生产环境禁止把验证码打进日志。请配置 CMG_SMS_PROVIDER=webhook + CMG_SMS_WEBHOOK_URL；确实只在受控环境里跑再设 CMG_SMS_ALLOW_CONSOLE=1'
        : '验证码只打印在网关日志里，仅供本机/内网自测'
    }
  }
  if (SMS.provider === 'webhook') {
    return {
      name: 'webhook',
      ready: Boolean(SMS.webhookUrl),
      blocked: false,
      hint: SMS.webhookUrl ? `转发到 ${SMS.webhookUrl}` : '未配置 CMG_SMS_WEBHOOK_URL'
    }
  }
  return {
    name: SMS.provider,
    ready: false,
    blocked: true,
    hint: `未知短信通道 "${SMS.provider}"（可选：console / webhook）`
  }
}

class SmsError extends Error {
  constructor(reason, message) {
    super(message)
    this.name = 'SmsError'
    this.reason = reason
  }
}

/* ------------------------------- 发送 ------------------------------- */

const SEND_TIMEOUT_MS = 10000

async function callWebhook(phone, code, purpose) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), SEND_TIMEOUT_MS)
  try {
    const resp = await fetch(SMS.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(SMS.webhookToken ? { Authorization: `Bearer ${SMS.webhookToken}` } : {})
      },
      // 只发必要字段：短信服务那边只需要号码、内容与时效
      body: JSON.stringify({ phone, code, purpose, expiresInMinutes: SMS.ttlMinutes }),
      signal: ac.signal
    })
    const text = (await resp.text().catch(() => '')).slice(0, 300)
    if (!resp.ok) {
      throw new SmsError('sms_failed', `短信服务返回 ${resp.status}${text ? `：${text}` : ''}`)
    }
    return text || null
  } catch (err) {
    if (err instanceof SmsError) throw err
    throw new SmsError('sms_failed', `短信服务不可达：${(err && err.message) || '未知错误'}`)
  } finally {
    // 必须放 finally：fetch 抛错时定时器不清理会悬空（本项目在 STT 上踩过这个坑）
    clearTimeout(timer)
  }
}

async function sendSms(phone, code, purpose) {
  const info = providerInfo()
  if (!info.ready) {
    // 「未配置」必须明确报错。静默成功（假装发了）会让用户永远卡在"收不到验证码"，
    // 而且从服务端看不出任何异常 —— 这是最难排查的一类故障。
    throw new SmsError('sms_not_configured', `短信通道未就绪：${info.hint}`)
  }
  if (SMS.provider === 'console') {
    const label = purpose === 'register' ? '注册' : '登录'
    console.log(`[短信·本机通道] ${phone} → ${code}（${label}用，${SMS.ttlMinutes} 分钟内有效）`)
    return { provider: 'console', reference: null }
  }
  return { provider: 'webhook', reference: await callWebhook(phone, code, purpose) }
}

/* ---------------------------- 验证码的存与验 ---------------------------- */

/**
 * 只存 HMAC，不存明文。
 *
 * 注意：**6 位数字的裸哈希毫无意义** —— 10^6 次穷举在手机上都是瞬间的事。
 * 所以这里用 GATEWAY_SECRET 当 pepper：能读库但拿不到 `data/gateway.secret` 的人
 * 才反查不出来。这不是"比明文好看一点"，而是唯一让它真正有意义的做法。
 */
function hashCode(phone, purpose, code) {
  return crypto
    .createHmac('sha256', GATEWAY_SECRET)
    .update(`${phone}:${purpose}:${code}`)
    .digest('base64url')
}

function newCode() {
  // randomInt 无模偏差；补零保证恒为 6 位
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

/**
 * 签发并发一条验证码。发送失败会抛 SmsError，**此时不落库**。
 * 返回 ttlMinutes 让客户端能显示倒计时。
 */
async function issueCode(phone, purpose) {
  const code = newCode()
  const sent = await sendSms(phone, code, purpose)
  db.insertPhoneCode({
    phone,
    purpose,
    codeHash: hashCode(phone, purpose, code),
    expiresAt: Date.now() + SMS.ttlMinutes * 60000
  })
  return { provider: sent.provider, ttlMinutes: SMS.ttlMinutes }
}

/**
 * 校验并**消费**验证码。成功即作废，所以同一个码不能拿去注册两个号、也不能登录两次。
 * 失败返回 { ok:false, reason, message }，reason 给客户端分支用，message 直接展示。
 */
function verifyCode(phone, purpose, code) {
  const input = String(code || '').trim()
  if (!/^\d{6}$/.test(input)) {
    return { ok: false, reason: 'code_invalid', message: '验证码为 6 位数字' }
  }

  const row = db.latestPhoneCode(phone, purpose)
  if (!row) return { ok: false, reason: 'code_missing', message: '请先获取验证码' }
  if (row.expires_at < Date.now()) {
    return { ok: false, reason: 'code_expired', message: '验证码已过期，请重新获取' }
  }
  if (row.attempts >= SMS.maxAttempts) {
    return { ok: false, reason: 'code_locked', message: '验证码尝试次数过多，请重新获取' }
  }

  const expected = Buffer.from(hashCode(phone, purpose, input))
  const actual = Buffer.from(row.code_hash)
  const same = expected.length === actual.length && crypto.timingSafeEqual(expected, actual)

  if (!same) {
    const attempts = db.bumpPhoneCodeAttempts(row.id)
    if (attempts >= SMS.maxAttempts) {
      // 最后一次机会用掉了，直接告诉用户要重新获取，别让他继续猜
      return { ok: false, reason: 'code_locked', message: '验证码尝试次数过多，请重新获取' }
    }
    return {
      ok: false,
      reason: 'code_wrong',
      message: `验证码不正确（还可尝试 ${SMS.maxAttempts - attempts} 次）`
    }
  }

  if (!db.consumePhoneCode(row.id)) {
    // 并发下已被另一个请求用掉（同一码同时提交两次）
    return { ok: false, reason: 'code_used', message: '验证码已被使用，请重新获取' }
  }
  return { ok: true }
}

/**
 * 距离下次可发送还有多少毫秒（0 = 现在就能发）。
 *
 * 用「上一条验证码的创建时间」而不是限流计数来判断冷却：计数会在**发送失败**时
 * 也被消耗掉，用户明明没收到短信却要白等 60 秒。DB 里只有"真的发出去了"才有记录，
 * 判断天然精确。
 */
function cooldownRemainingMs(phone, purpose) {
  const last = db.lastPhoneCodeAt(phone, purpose)
  if (!last) return 0
  return Math.max(0, SMS.resendSeconds * 1000 - (Date.now() - last))
}

/* 定期清掉过期/已消费的记录。`unref()` 保证不阻止进程退出。 */
db.purgePhoneCodes()
setInterval(() => db.purgePhoneCodes(), 600000).unref()

module.exports = {
  SmsError,
  providerInfo,
  sendSms,
  issueCode,
  verifyCode,
  cooldownRemainingMs,
  /** 暴露给测试与 `/health`，避免测试去 hardcode 一份配置 */
  config: SMS,
  hashCode
}
