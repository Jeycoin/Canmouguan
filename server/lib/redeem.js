'use strict'

/**
 * 兑换码：第一步商业化里**唯一**的发会员通路（支付还没接）。
 *
 * 为什么先做兑换码而不是先接支付：
 * 支付有资质、签约、回调对账、退款一整套，做完才发现"根本没人愿意付"就全白费。
 * 兑换码让整个"发会员 → 用户真的用起来 → 用量数据"的闭环先跑通，
 * 你需要验证的假设只有一个：**用户拿到云端版之后，愿不愿意继续用下去、并为此付钱。**
 */

const crypto = require('node:crypto')
const db = require('./db')
const { REDEEM_PLANS } = require('./env')

/**
 * 去掉易混字符（0/O、1/I/L、U/V）的字母表。
 * 兑换码是要**用户手抄/口述/微信里发**的，读错一位就是一次客服。
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTWXYZ'

function randomGroup(len = 5) {
  const bytes = crypto.randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

function newCode(prefix = 'CMG') {
  return `${prefix}-${randomGroup()}-${randomGroup()}-${randomGroup()}`
}

/**
 * 归一化：允许用户带空格、小写、漏写前缀地输入，尽量不因为"格式不对"退掉一次兑换。
 *
 * 但**长度或字符集不对就是格式错误**，不能放行去查库 —— 否则用户看到的是"兑换码不存在"，
 * 而真实原因是他少输了一位或抄错了字符，提示会把人带偏。
 * 注意码表（ALPHABET）刻意剔除了 0/O/1/I/L/U/V，所以出现这些字符一定是抄错了，
 * **不做模糊纠正**（纠正成什么都是猜），直接判格式错误更诚实。
 */
function normalizeCode(input) {
  if (typeof input !== 'string') return ''
  let s = input.toUpperCase().replace(/[^0-9A-Z]/g, '')
  // 允许省略 CMG 前缀：有些用户只抄了后面三段
  if (!s.startsWith('CMG')) s = 'CMG' + s
  const body = s.slice(3)
  if (body.length !== 15) return ''
  for (const ch of body) {
    if (!ALPHABET.includes(ch)) return ''
  }
  return `CMG-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}`
}

/** 批量生成（同样写入 codes 表，码本身也是唯一索引，重复会自动失败） */
function generateBatch({ kind = 'month', count = 10, batch = null, note = null }) {
  const spec = REDEEM_PLANS[kind]
  if (!spec) throw new Error(`未知的兑换码类型：${kind}`)
  const tag = batch || `b${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomGroup(4)}`
  const created = []
  for (let i = 0; i < count; i++) {
    // 撞码概率极低（32^15），但真撞了就是一次 INSERT 失败，重试即可
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode()
      try {
        db.insertCode({ code, plan: spec.plan, days: spec.days, batch: tag, note })
        created.push({ code, ...spec })
        break
      } catch {
        /* 撞码，换一个 */
      }
    }
  }
  return { batch: tag, codes: created }
}

/**
 * 核销。
 *
 * 顺序很重要：**先原子核销、再改用户套餐**。
 * 反过来的话，两个请求同时兑同一个码会双双通过检查、双双加一个月（白送一个月）。
 */
function redeem(user, rawCode) {
  const code = normalizeCode(rawCode)
  if (!code) {
    return { ok: false, reason: 'invalid_format', message: '兑换码格式不对，应为 CMG-XXXXX-XXXXX-XXXXX' }
  }

  const record = db.getCode(code)
  if (!record) return { ok: false, reason: 'not_found', message: '兑换码不存在，请检查是否输错' }
  if (record.redeemed_at) {
    return { ok: false, reason: 'already_redeemed', message: '这个兑换码已经被使用过了' }
  }

  const claimed = db.redeemCode(code, user.id)
  if (!claimed) {
    // 走到这里说明在"查"和"改"之间被别人抢了
    return { ok: false, reason: 'already_redeemed', message: '这个兑换码已经被使用过了' }
  }

  // 续期语义：已是有效会员就在原到期时间上叠加；否则从此刻起算。
  // （叠加而不是覆盖，用户才不会因为"提前续费"反而吃亏。）
  const now = Date.now()
  const base =
    user.plan === record.plan && user.plan_expires_at && user.plan_expires_at > now
      ? user.plan_expires_at
      : now
  const expiresAt = base + record.days * 86400000

  db.setPlan(user.id, record.plan, expiresAt)
  db.logEvent('redeem', user.id, `${code} +${record.days}天`)

  const fresh = db.userById(user.id)
  return {
    ok: true,
    plan: record.plan,
    days: record.days,
    expiresAt,
    /** 是"续期"还是"新开通"，用于给用户不同的文案 */
    extended: base !== now,
    user: fresh
  }
}

module.exports = { newCode, normalizeCode, generateBatch, redeem }
