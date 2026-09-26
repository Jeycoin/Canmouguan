'use strict'

/**
 * 语音（ASR）代理。两条通路性质完全不同，分别处理：
 *
 *  1. **文件转写**（HTTP multipart）—— 简单反向代理，但要在转发前**算出音频时长**用来计量。
 *  2. **实时转写**（WebSocket 长连接）—— 难点所在：
 *     - 必须**双向透传**，绝不能"收完再发"。实时转写的全部价值就是延迟，
 *       一旦在中间攒批，用户看到的就变成"说完整段话之后才出字"。
 *     - 计量按**音频字节数**折算秒数（PCM16 单声道：字节数 ÷ (采样率 × 2)）。
 *       按帧数计量会被帧长变化坑到，按字节计量则与分帧方式无关。
 */

const WebSocket = require('ws')
const crypto = require('node:crypto')

const {
  DASHSCOPE_API_KEY,
  DASHSCOPE_HTTP,
  DASHSCOPE_WS,
  ASR_ALLOWED_MODELS,
  MAX_UPLOAD_BYTES
} = require('./env')
const { ok, fail, readBody } = require('./http')
const quota = require('./quota')
const db = require('./db')
const { authenticate } = require('./auth')

/* --------------------------- WAV 时长解析 --------------------------- */

/**
 * 从 multipart 请求体里抠出 WAV 头，算出音频时长（秒）。
 *
 * 为什么要这么麻烦：**计费必须有服务端能独立验证的时长**。
 * 如果改成"客户端报一个时长"，就等于让用户自己决定扣多少额度。
 * 这里直接读音频容器里的采样率与数据长度，是客户端无法伪造的。
 */
function wavSecondsFromBody(body, bytesPerSecondFallback = 32000) {
  const riff = body.indexOf('RIFF')
  if (riff === -1 || riff + 44 > body.length) return null
  if (body.toString('ascii', riff + 8, riff + 12) !== 'WAVE') return null

  let channels = body.readUInt16LE(riff + 22)
  let sampleRate = body.readUInt32LE(riff + 24)
  let bits = body.readUInt16LE(riff + 34)

  // 逐块扫描，找 data chunk（WAV 允许 fmt 和 data 之间有其他块）
  let offset = riff + 12
  let dataSize = 0
  while (offset + 8 <= body.length) {
    const id = body.toString('ascii', offset, offset + 4)
    const size = body.readUInt32LE(offset + 4)
    if (id === 'data') {
      dataSize = size
      break
    }
    // 有些实现的 fmt 块长度大于 16，靠 size 跳过去才能对上
    offset += 8 + size + (size % 2)
  }

  if (!dataSize) {
    // 找不到 data 块：退化成"文件总长减去头"，仍然比信客户端强
    dataSize = Math.max(0, body.length - riff - 44)
  }
  if (!channels || !sampleRate || !bits) return null

  const bytesPerSecond = sampleRate * channels * (bits / 8)
  if (!bytesPerSecond) return null
  return dataSize / bytesPerSecond
}

/** 从 multipart 文本里读一个普通字段（用于校验 model 是否在白名单内） */
function multipartField(body, name) {
  const marker = Buffer.from(`name="${name}"`)
  const at = body.indexOf(marker)
  if (at === -1) return ''
  const sep = body.indexOf('\r\n\r\n', at)
  if (sep === -1) return ''
  const end = body.indexOf('\r\n', sep + 4)
  if (end === -1) return ''
  return body.toString('utf8', sep + 4, end).trim()
}

/* --------------------------- 1. 文件转写 --------------------------- */

async function handleTranscriptions(req, res, ctx) {
  const user = ctx.user
  const check = quota.checkAsr(user)
  if (!check.ok) return fail(res, 402, check.reason, check.message)

  if (!DASHSCOPE_API_KEY) {
    return fail(res, 500, 'gateway_misconfigured', '网关未配置语音密钥（CMG_DASHSCOPE_API_KEY）')
  }

  let body
  try {
    body = await readBody(req, MAX_UPLOAD_BYTES)
  } catch (e) {
    if (e.code === 'payload_too_large') {
      return fail(res, 413, 'payload_too_large', '音频过大，请缩短单段录音')
    }
    return fail(res, 400, 'bad_request', '读取请求体失败')
  }

  const contentType = req.headers['content-type'] || ''
  if (!contentType.includes('multipart/form-data')) {
    return fail(res, 400, 'bad_content_type', 'Content-Type 必须是 multipart/form-data')
  }

  // 模型白名单校验（只校验，不重写 —— 重写 multipart 得不偿失）
  const model = multipartField(body, 'model')
  if (model && !ASR_ALLOWED_MODELS.includes(model)) {
    return fail(res, 400, 'model_not_allowed', `模型 ${model} 不在可用列表内`)
  }

  const seconds = wavSecondsFromBody(body)
  if (seconds != null) {
    const recheck = quota.checkAsr(user, seconds)
    if (!recheck.ok) return fail(res, 402, recheck.reason, recheck.message)
  }

  let upstream
  try {
    upstream = await fetch(`${DASHSCOPE_HTTP.replace(/\/+$/, '')}/compatible-mode/v1/audio/transcriptions`, {
      method: 'POST',
      // Content-Type 必须**原样透传**：里面有 multipart 的 boundary，重写就解析不了
      headers: {
        'Content-Type': contentType,
        Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
        'X-DashScope-DataInspection': 'enable'
      },
      body
    })
  } catch (err) {
    db.logEvent('asr_file_upstream_error', user.id, err && err.message)
    return fail(res, 502, 'upstream_unreachable', `转写服务不可达：${err.message}`)
  }

  const text = await upstream.text().catch(() => '')
  if (!upstream.ok) {
    db.logEvent('asr_file_upstream_status', user.id, `${upstream.status} ${text.slice(0, 300)}`)
    return fail(res, upstream.status, 'upstream_error', `转写服务返回 ${upstream.status}`, {
      detail: text.slice(0, 1000)
    })
  }

  // 只有成功才计费
  const charged = seconds != null ? seconds : body.length / 32000
  quota.chargeAsr(user, charged)
  db.logEvent('asr_file_ok', user.id, `seconds=${charged.toFixed(1)} model=${model || 'default'}`)

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

/* -------------------------- 2. 实时转写（WS） -------------------------- */

/** 把一个 run-task 里的采样率读出来，用于字节→秒换算 */
function sampleRateFromRunTask(text) {
  try {
    const obj = JSON.parse(text)
    const sr = obj?.payload?.parameters?.sample_rate
    const n = Number(sr)
    return Number.isFinite(n) && n > 0 ? n : 16000
  } catch {
    return 16000
  }
}

function runTaskModel(text) {
  try {
    return String(JSON.parse(text)?.payload?.model || '')
  } catch {
    return ''
  }
}

/**
 * 处理 `/v1/asr/realtime` 的 WS 升级。
 *
 * 协议刻意做成**与百炼同构**：客户端只改 URL 和鉴权头，其余一行不用动。
 * 网关不理解语义，只负责鉴权、计量、透传 —— 这样上游协议改动时网关不用跟着改。
 */
function handleRealtimeUpgrade(req, socket, head, url) {
  const auth = authenticate(req, url)
  if (!auth) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  const user = auth.user

  const check = quota.checkAsr(user)
  if (!check.ok) {
    socket.write(
      `HTTP/1.1 402 Payment Required\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${check.message}`
    )
    socket.destroy()
    return
  }
  const slot = quota.acquireRealtimeSlot(user)
  if (!slot.ok) {
    socket.write(
      `HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${slot.message}`
    )
    socket.destroy()
    return
  }

  if (!DASHSCOPE_API_KEY) {
    quota.releaseRealtimeSlot(user.id)
    socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n网关未配置语音密钥')
    socket.destroy()
    return
  }

  const wss = getUpgradeServer()
  wss.handleUpgrade(req, socket, head, (client) => {
    const taskId = crypto.randomUUID().replace(/-/g, '')
    let sampleRate = 16000
    let billedBytes = 0
    let flushedSeconds = 0
    let closed = false
    let quotaKilled = false
    let flushTimer = null
    /**
     * 建立连接那一刻的剩余额度 = 本次会话允许消耗的秒数上限。
     * 用"连接时的快照"当预算，而不是每帧都去查库 —— 后者既慢又有竞态。
     */
    const budgetSeconds = check.entitlement.asr.remaining

    const up = new WebSocket(DASHSCOPE_WS, {
      headers: {
        // ⚠️ 用**网关自己的**真 Key，绝不能用客户端带来的（那是我们的 token）
        Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
        'X-DashScope-DataInspection': 'enable',
        'User-Agent': 'canmouguan-gateway/0.1'
      },
      handshakeTimeout: 12000
    })

    const secondsBilled = () => billedBytes / (sampleRate * 2)

    /**
     * 客户端到上游的发送队列。
     *
     * ⚠️ 这里踩过坑，别再改回 `if (up.readyState === OPEN) up.send(...)`：
     * 客户端是在自己的 `ws.on('open')` 里**立刻**发 `run-task` 的，而那一刻
     * 网关到上游的握手很可能还没完成。直接判 OPEN 就把这条启动指令**静默丢掉**了，
     * 表现是"能连上、但永远不出字"，而且不报任何错。
     * 所以握手期间必须**排队**，等上游 open 后按序补发。
     */
    const outbox = []
    const sendUp = (data, opts) => {
      if (up.readyState === WebSocket.OPEN) {
        try {
          up.send(data, opts)
        } catch (err) {
          db.logEvent('asr_rt_send_error', user.id, err && err.message)
          cleanup()
        }
        return
      }
      if (up.readyState === WebSocket.CONNECTING) {
        outbox.push([data, opts])
        return
      }
      // CLOSING / CLOSED：上游已经没了，直接收摊
      cleanup()
    }

    /** 把"已播秒数 - 已记账秒数"的差额补记上。只在不小于 0 时写库。 */
    const settle = () => {
      const seconds = secondsBilled()
      const delta = seconds - flushedSeconds
      if (delta > 0) {
        quota.chargeAsr(user, delta)
        flushedSeconds = seconds
      }
      return seconds
    }

    const cleanup = () => {
      if (closed) return
      closed = true
      if (flushTimer) clearInterval(flushTimer)
      // 把最后不足一次 flush 的零头也记上，否则每次断开都会漏掉一点
      settle()
      quota.releaseRealtimeSlot(user.id)
      try {
        up.close()
      } catch {
        /* noop */
      }
      try {
        client.close()
      } catch {
        /* noop */
      }
    }

    /** 定期落库：长连接跑一小时，不能等断开才记账（进程崩了会全丢） */
    flushTimer = setInterval(settle, 5000)
    flushTimer.unref()

    up.on('open', () => {
      // 握手完成，把排队中的 run-task 等控制指令补发出去
      while (outbox.length) {
        const [data, opts] = outbox.shift()
        try {
          up.send(data, opts)
        } catch (err) {
          db.logEvent('asr_rt_send_error', user.id, err && err.message)
          cleanup()
          return
        }
      }
      db.logEvent('asr_rt_open', user.id, `task=${taskId}`)
    })

    up.on('message', (data, isBinary) => {
      if (closed) return
      try {
        client.send(data, { binary: isBinary })
      } catch {
        cleanup()
      }
    })

    up.on('error', (err) => {
      db.logEvent('asr_rt_upstream_error', user.id, err && err.message)
      try {
        client.send(
          JSON.stringify({
            header: { event: 'task-failed', error_code: 'UpstreamError', error_message: err.message }
          })
        )
      } catch {
        /* noop */
      }
      cleanup()
    })

    up.on('close', () => cleanup())

    client.on('message', (data, isBinary) => {
      if (closed) return

      if (isBinary) {
        billedBytes += data.length
        // 超额度：立刻停，并且**用客户端已经认识的 task-failed 事件**告知原因，
        // 这样界面不需要为"额度耗尽"写任何特殊分支。
        // 文案与 `quota.js` 的 denyText 保持一致口径：只有"兑换兑换码"这一条续期通路，
        // 不要再写"开通会员"—— 产品里没有那个动作，用户会去找一个不存在的入口。
        if (secondsBilled() > budgetSeconds) {
          if (!quotaKilled) {
            quotaKilled = true
            try {
              client.send(
                JSON.stringify({
                  header: {
                    event: 'task-failed',
                    error_code: 'QuotaExceeded',
                    error_message: '本月语音额度已用完，录音已自动停止。兑换新的兑换码后可继续使用。'
                  }
                })
              )
            } catch {
              /* noop */
            }
          }
          cleanup()
          return
        }
        // 一律走队列：既能在握手期排队，也能保证"启动指令在前、音频在后"的顺序
        sendUp(data, { binary: true })
        return
      }

      // 文本帧：run-task / finish-task 等控制指令，原样转发
      const text = data.toString('utf8')
      if (text.includes('run-task')) {
        sampleRate = sampleRateFromRunTask(text)
        const model = runTaskModel(text)
        if (model && !ASR_ALLOWED_MODELS.includes(model)) {
          try {
            client.send(
              JSON.stringify({
                header: {
                  event: 'task-failed',
                  error_code: 'ModelNotAllowed',
                  error_message: `模型 ${model} 不在可用列表内`
                }
              })
            )
          } catch {
            /* noop */
          }
          cleanup()
          return
        }
      }
      sendUp(text)
    })

    client.on('error', () => cleanup())
    client.on('close', () => cleanup())
  })
}

/* ---------------------------- 单例 WSS ---------------------------- */

let upgradeServer = null
function getUpgradeServer() {
  if (!upgradeServer) upgradeServer = new WebSocket.Server({ noServer: true })
  return upgradeServer
}

module.exports = { handleTranscriptions, handleRealtimeUpgrade }
