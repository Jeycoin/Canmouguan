'use strict'

/**
 * 认证：口令哈希 + 自签 token。
 *
 * 不引 jsonwebtoken：我们只需要"签名 + 过期"两件事，
 * 一个 HMAC 就够，没必要为此多一个依赖（网关是要长期跑在公网上的，依赖越少越好）。
 */

const crypto = require('node:crypto')
const { GATEWAY_SECRET, TOKEN_TTL_MS } = require('./env')
const db = require('./db')

/* ------------------------------ 口令哈希 ------------------------------ */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

/**
 * scrypt 是内存硬函数，比 PBKDF2 更抗 GPU 爆破；
 * `crypto.scryptSync` 用 maxmem 默认值就够（N=16384 约需 16MB）。
 */
function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('base64url')
  return { hash, salt }
}

function verifyPassword(password, expectedHash, salt) {
  const { hash } = hashPassword(password, salt)
  const a = Buffer.from(hash)
  const b = Buffer.from(expectedHash)
  // 定长比较：长度不同直接 false（timingSafeEqual 要求等长）
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/* -------------------------------- token -------------------------------- */

function b64u(input) {
  return Buffer.from(input).toString('base64url')
}

function sign(data) {
  return crypto.createHmac('sha256', GATEWAY_SECRET).update(data).digest('base64url')
}

/**
 * token = `v1.<payload>.<sig>`
 * payload 只放 uid 与 exp —— **不放任何敏感信息**，它只是签名过的、不是加密的。
 */
function issueToken(userId, ttlMs = TOKEN_TTL_MS) {
  const payload = b64u(JSON.stringify({ uid: userId, exp: Date.now() + ttlMs }))
  return `v1.${payload}.${sign(payload)}`
}

function verifyToken(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  const [, payload, sig] = parts
  const expected = sign(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed.uid !== 'number' || typeof parsed.exp !== 'number') return null
  if (Date.now() > parsed.exp) return null
  return parsed
}

/* ---------------------------- 请求侧辅助 ---------------------------- */

/** 从 header / query / 子协议里取 Bearer token。
 *  浏览器 WebSocket 不能自定义 header，所以 WS 侧额外支持 `?token=` 与子协议两种传法。 */
function extractToken(req, url) {
  const header = req.headers['authorization'] || req.headers['Authorization']
  if (typeof header === 'string' && /^Bearer\s+/i.test(header)) {
    return header.replace(/^Bearer\s+/i, '').trim()
  }
  if (url && typeof url.searchParams.get('token') === 'string') {
    return url.searchParams.get('token').trim()
  }
  return ''
}

/**
 * 认请求。返回 { user, token } 或 null。
 * 每次都会查一次库，而不是只信 token —— 这样**封号 / 改套餐立刻生效**，
 * 不用等 token 过期。
 */
function authenticate(req, url) {
  const token = extractToken(req, url)
  if (!token) return null
  const claims = verifyToken(token)
  if (!claims) return null
  const user = db.userById(claims.uid)
  if (!user || user.disabled) return null
  return { user, token }
}

module.exports = { hashPassword, verifyPassword, issueToken, verifyToken, extractToken, authenticate }
