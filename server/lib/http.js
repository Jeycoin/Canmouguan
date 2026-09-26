'use strict'

/** 通用 HTTP 小工具：不引框架，只把重复的那点样板收起来。 */

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  })
  res.end(text)
}

/** 统一的失败响应：客户端按 `reason` 分支，不要去匹配 message 文案 */
function fail(res, status, reason, message, extra) {
  json(res, status, { ok: false, reason, message, ...(extra || {}) })
}

function ok(res, body) {
  json(res, 200, { ok: true, ...(body || {}) })
}

/**
 * 读请求体，带硬上限。
 *
 * **必须设上限**：这个端点接收的是音频，不设上限的话一个恶意请求就能把内存吃光。
 * 超限直接销毁连接，而不是读完再判断 —— 读完就已经晚了。
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let done = false
    req.on('data', (chunk) => {
      if (done) return
      total += chunk.length
      if (total > maxBytes) {
        done = true
        reject(Object.assign(new Error('payload_too_large'), { code: 'payload_too_large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!done) {
        done = true
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', (err) => {
      if (!done) {
        done = true
        reject(err)
      }
    })
  })
}

async function readJson(req, maxBytes = 64 * 1024) {
  const buf = await readBody(req, maxBytes)
  if (!buf.length) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw Object.assign(new Error('invalid_json'), { code: 'invalid_json' })
  }
}

/* ------------------------------ 限流 ------------------------------ */

/**
 * 进程内的滑动窗口限流，主要用于**登录/注册**接口。
 *
 * 只防"脚本暴力撞密码"这一档，不做分布式限流 —— 单机网关用内存计数就够；
 * 真到了多实例的规模，这层本来就该换成 Redis，那时再换。
 */
const buckets = new Map()

function rateLimit(key, limit, windowMs) {
  const now = Date.now()
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs)
  if (hits.length >= limit) {
    buckets.set(key, hits)
    return { ok: false, retryAfterMs: windowMs - (now - hits[0]) }
  }
  hits.push(now)
  buckets.set(key, hits)
  return { ok: true }
}

/** 偶尔清一下空桶，避免长期运行下 Map 无限增长 */
setInterval(() => {
  const now = Date.now()
  for (const [key, hits] of buckets) {
    const alive = hits.filter((t) => now - t < 3600000)
    if (!alive.length) buckets.delete(key)
    else buckets.set(key, alive)
  }
}, 600000).unref()

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim()
  return req.socket.remoteAddress || 'unknown'
}

/**
 * 宽松 CORS。
 *
 * 客户端是 Electron 的**主进程**在发请求（Node 的 fetch / ws），本来不受同源策略约束，
 * 所以这个不是必需的。留着是为了能用浏览器/调试工具直接打接口做排障。
 */
function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

module.exports = { json, ok, fail, readBody, readJson, rateLimit, clientIp, applyCors }
