'use strict'

/**
 * LLM 代理：把 OpenAI 兼容的请求原样转发给上游，把响应**流式**回传。
 *
 * ⚠️ 这一层最容易做错的地方是"缓冲"。面试辅助的价值全在**首字延迟**上，
 * 一旦在这里把流攒成一个完整响应再发（很多反向代理默认就这么干），
 * 界面就会从"逐字蹦出来"退化成"干等十几秒然后一次性出现"。
 * 所以下面全程 `for await (const chunk of ...)` 立即 `res.write()`，绝不聚合。
 */

const {
  LLM_API_KEY,
  LLM_BASE_URL,
  LLM_MODEL,
  LLM_VISION_MODEL,
  LLM_ALLOWED_MODELS
} = require('./env')
const { readJson, fail, json } = require('./http')
const quota = require('./quota')
const db = require('./db')

/** 单次请求的输出上限。不加这个，用户传个 100 万 max_tokens 就能把成本打爆。 */
const MAX_OUTPUT_TOKENS = 4096

/** 只转发这些字段到上游：其余一律丢弃，避免把客户端的随意字段透给上游 */
const FORWARD_FIELDS = [
  'messages',
  'temperature',
  'top_p',
  'max_tokens',
  'stream',
  'stop',
  'frequency_penalty',
  'presence_penalty',
  'response_format',
  'tools',
  'tool_choice'
]

/**
 * 客户端传来的模型名**必须走白名单**。
 * 直接透传等于把"你账号里能调用的所有模型"开放给用户，包括贵得多的那些。
 */
function pickModel(requested, hasImage) {
  const fallback = hasImage ? LLM_VISION_MODEL : LLM_MODEL
  if (typeof requested !== 'string' || !requested) return fallback
  return LLM_ALLOWED_MODELS.includes(requested) ? requested : fallback
}

function hasImageContent(messages) {
  if (!Array.isArray(messages)) return false
  for (const m of messages) {
    if (Array.isArray(m?.content)) {
      if (m.content.some((p) => p && p.type === 'image_url')) return true
    }
  }
  return false
}

function buildUpstreamBody(input) {
  const messages = Array.isArray(input.messages) ? input.messages : []
  const model = pickModel(input.model, hasImageContent(messages))

  const body = { model }
  for (const key of FORWARD_FIELDS) {
    if (input[key] !== undefined) body[key] = input[key]
  }
  // 模型名以我们选定的为准（上面可能因白名单/视觉而改写）
  body.model = model
  body.max_tokens = Math.min(Number(body.max_tokens) || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS)
  // 不显式指定时默认流式：面试辅助几乎总是要流式，非流式反而是特例
  if (body.stream === undefined) body.stream = true
  // 让上游把 usage 带在最后一个包里，用于统计（部分上游不支持，失败也无所谓）
  if (body.stream === true) body.stream_options = { include_usage: true }

  return { body, model }
}

async function handleChatCompletions(req, res, ctx) {
  const user = ctx.user

  const check = quota.checkLlm(user)
  if (!check.ok) return fail(res, 402, check.reason, check.message)

  if (!LLM_API_KEY) {
    return fail(res, 500, 'gateway_misconfigured', '网关未配置大模型密钥（CMG_LLM_API_KEY）')
  }

  let input
  try {
    input = await readJson(req, 4 * 1024 * 1024)
  } catch (e) {
    if (e.code === 'payload_too_large') return fail(res, 413, 'payload_too_large', '请求体过大')
    return fail(res, 400, 'invalid_json', '请求体不是合法 JSON')
  }

  const { body, model } = buildUpstreamBody(input)

  // 客户端断开时也要中止上游请求，否则会留下一个没人要的流在烧钱
  const ac = new AbortController()
  const onClose = () => ac.abort()
  res.on('close', onClose)

  let upstream
  try {
    upstream = await fetch(`${LLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`,
        Accept: body.stream ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(body),
      signal: ac.signal
    })
  } catch (err) {
    res.off('close', onClose)
    if (ac.signal.aborted) return
    db.logEvent('llm_upstream_error', user.id, err && err.message)
    return fail(res, 502, 'upstream_unreachable', `上游不可达：${err.message}`)
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '')
    res.off('close', onClose)
    db.logEvent('llm_upstream_status', user.id, `${upstream.status} ${text.slice(0, 300)}`)
    // 上游有完整信息，原样透出去最利于排查（401/429 都能被客户端正确归类）
    return json(res, upstream.status, {
      ok: false,
      reason: 'upstream_error',
      message: `上游返回 ${upstream.status}`,
      detail: text.slice(0, 2000)
    })
  }

  /* --------------------------- 计费：只在成功后记 --------------------------- */
  quota.chargeLlm(user, 0)

  const isStream = body.stream === true
  if (!isStream) {
    const data = await upstream.json().catch(() => null)
    res.off('close', onClose)
    if (!data) return fail(res, 502, 'upstream_bad_response', '上游返回的不是合法 JSON')
    const tokens = Number(data?.usage?.total_tokens) || 0
    if (tokens) quota.chargeLlmTokens(user, tokens)
    db.logEvent('llm_ok', user.id, `model=${model} tokens=${tokens} stream=0`)
    return okJson(res, data)
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 明确告诉中间层别缓冲（有些反向代理认这个头）
    'X-Accel-Buffering': 'no'
  })

  let usageTokens = 0
  let textChars = 0

  try {
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // 原样转发，不做任何改写 —— 客户端本来就按 OpenAI SSE 解析
      res.write(value)

      // 顺带统计：只有需要 usage 时才解析，解析失败绝不影响转发
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const obj = JSON.parse(payload)
          if (obj.usage && typeof obj.usage.total_tokens === 'number') usageTokens = obj.usage.total_tokens
          const delta = obj.choices?.[0]?.delta
          if (delta && typeof delta.content === 'string') textChars += delta.content.length
        } catch {
          /* 不完整的 JSON 片段，跳过 */
        }
      }
    }
    res.end()
  } catch (err) {
    // 客户端提前断开（AbortError）是正常情况，不记错误
    if (!ac.signal.aborted) {
      db.logEvent('llm_stream_error', user.id, err && err.message)
      try {
        res.end()
      } catch {
        /* 连接可能已经没了 */
      }
    }
  } finally {
    res.off('close', onClose)
  }

  // 流结束后回填真实 token 数（有就算，没有就用字符数粗估，仅用于统计）
  quota.chargeLlmTokens(user, usageTokens || Math.ceil(textChars / 2))
  db.logEvent(
    'llm_ok',
    user.id,
    `model=${model} tokens=${usageTokens || Math.ceil(textChars / 2)} chars=${textChars} stream=1`
  )
}

/** 非流式分支：直接把上游 JSON 原样返回 */
function okJson(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

module.exports = { handleChatCompletions }
