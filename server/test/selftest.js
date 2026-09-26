#!/usr/bin/env node
'use strict'

/**
 * 网关端到端自测。
 *
 * 关键设计：**起一个假上游**，把网关的 `CMG_DASHSCOPE_*` / `CMG_LLM_*` 全指过去。
 * 这样整套流程（注册→登录→兑换→LLM 流式→文件转写→实时转写→额度耗尽）都能在没有真实
 * 上游密钥、不花一分钱的情况下跑完，而且**每一次都走真实 HTTP/WS**，不是调函数。
 *
 * 网关本身是 spawn 成**子进程**跑的 —— 只有这样才能验证真实的启动路径与配置注入，
 * 在同一个进程里 require 是测不到这些的。
 *
 * 用法：node server/test/selftest.js
 */

const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const WebSocket = require('ws')

const SERVER_DIR = path.join(__dirname, '..')

/* --------------------------- 断言辅助 --------------------------- */

const results = []
function check(desc, pass, detail = '') {
  results.push([desc, pass])
  console.log(`  ${pass === true ? 'ok  ' : pass === false ? 'FAIL' : 'skip'} ${desc}${detail ? `   [${detail}]` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ----------------------------- 假上游 ----------------------------- */

/**
 * 尽量贴近真实协议形状：
 *  - 文件转写返回 {text}
 *  - chat/completions 按 stream 决定返回 SSE 还是 JSON
 *  - WS 走百炼的事件序列（task-started → result-generated → task-finished）
 */
function startMockUpstream() {
  const state = {
    llmCalls: 0,
    asrFileCalls: 0,
    realtimeConns: 0,
    realtimeBytes: 0,
    lastLlmModel: '',
    asrFileModel: '',
    /** 收到过的短信下发请求（webhook 通道用） */
    smsSends: [],
    smsAuth: null,
    /** 置 true 后 /sms 返回 500，用来验"发送失败"这条路径 */
    smsBroken: false
  }

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)

    /* 短信 webhook：网关把 {phone, code, purpose, expiresInMinutes} POST 过来，
       这边扮演"短信服务商适配器"。 */
    if (req.url.startsWith('/sms')) {
      state.smsAuth = req.headers.authorization || null
      let parsed = null
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        /* ignore */
      }
      if (state.smsBroken) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        return res.end('mock sms outage')
      }
      state.smsSends.push(parsed)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, id: `mock-${state.smsSends.length}` }))
    }

    if (req.url.startsWith('/compatible-mode/v1/audio/transcriptions')) {
      state.asrFileCalls++
      const m = body.toString('latin1').match(/name="model"[\s\S]{0,64}?\r\n\r\n([^\r\n]+)/)
      state.asrFileModel = m ? m[1].trim() : ''
      const json = JSON.stringify({ text: '这是假上游返回的转写结果' })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(json)
    }

    if (req.url.startsWith('/chat/completions')) {
      state.llmCalls++
      let parsed = {}
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        /* ignore */
      }
      // 记下上游**实际收到**的模型名：用来验证白名单改写是否生效
      state.lastLlmModel = parsed.model || ''
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        // 故意分成多个小包：如果网关中间做了缓冲，客户端就收不到"逐字到达"
        const words = ['你', '好', '，', '这', '是', '流', '式', '回', '答']
        for (const w of words) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`)
          await sleep(15)
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 42 } })}\n\n`)
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ choices: [{ message: { content: '非流式回答' } }], usage: { total_tokens: 7 } }))
    }

    res.writeHead(404)
    res.end('mock: not found')
  })

  const wss = new WebSocket.Server({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      state.realtimeConns++
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          state.realtimeBytes += data.length
          return
        }
        const text = data.toString('utf8')
        if (text.includes('run-task')) {
          ws.send(JSON.stringify({ header: { event: 'task-started', task_id: 'mock' } }))
        } else if (text.includes('finish-task')) {
          ws.send(
            JSON.stringify({
              header: { event: 'result-generated' },
              payload: { output: { sentence: { text: '实时转写结果', sentence_end: true } } }
            })
          )
          ws.send(JSON.stringify({ header: { event: 'task-finished' } }))
        }
      })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }))
  })
}

/* ------------------------------ 工具 ------------------------------ */

/** 造一段真实的 PCM16 16kHz 单声道 WAV */
function makeWav(seconds) {
  const sampleRate = 16000
  const samples = Math.floor(sampleRate * seconds)
  const dataSize = samples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)
  // 填一点真实波形，避免全零（全零会被当成静音，虽然这里不过 VAD，但更像真实数据）
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 440 * Math.PI * 2) * 8000), 44 + i * 2)
  }
  return buf
}

/** 手工构造 multipart 请求体（字段顺序也会被网关解析，所以这里刻意把 model 放在 file 前面） */
function makeMultipart(boundary, wav) {
  const parts = []
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nparaformer-v2\r\n`))
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
    )
  )
  parts.push(wav)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  return Buffer.concat(parts)
}

function pcmFrames(seconds, sampleRate = 16000) {
  const frames = []
  const frameSamples = Math.floor(sampleRate * 0.1) // 100ms，与客户端一致
  const total = Math.round(seconds / 0.1)
  for (let i = 0; i < total; i++) {
    const b = Buffer.alloc(frameSamples * 2)
    for (let s = 0; s < frameSamples; s++) b.writeInt16LE(Math.round(Math.sin(s / 20) * 6000), s * 2)
    frames.push(b)
  }
  return frames
}

/* ------------------------------ 主流程 ------------------------------ */

let mock
let gateway
let gateway2 = null
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmg-gw-test-'))
const PORT = 8899
const BASE = `http://127.0.0.1:${PORT}`
/** 第二个网关实例：换短信通道用。同一个 dataDir，顺便验证多进程共享密钥。 */
const PORT2 = 8900
const BASE2 = `http://127.0.0.1:${PORT2}`

/**
 * 把 pro 的额度压到极小，才好在几步之内测出"耗尽 → 熔断"。
 *
 * ⚠️ 这两个值**必须和下面 spawn 网关时注入的环境变量是同一个常量** ——
 * 分成两处写字面量，改了 env 忘了改断言（或反过来）时，
 * 失败信息会指向"额度不对"，而真实原因是测试自己前后不一致。
 *
 * 注意产品**没有免费额度**：未开通的账号额度恒为 0，不需要（也无法）用环境变量去压。
 */
const PRO_ASR_SECONDS = 3
const PRO_LLM_CALLS = 2

/**
 * 被测网关的环境变量。
 *
 * ⚠️ **必须显式写全，不能只靠 `process.env` 继承。**
 *
 * 网关启动时会加载它自己目录下的 `server/.env`（`lib/env.js` 的 `loadDotEnv` 只在
 * 变量**未定义**时才跳过），于是开发机上的真实配置会渗进自测。实测踩过：
 * `.env` 里一句 `CMG_ALLOW_SELF_REGISTER=0` 就让整个自测的注册链路全线失败
 * （107 项里挂 58 项），而失败信息只会说"暂未开放自助注册" —— 完全指不到真实原因，
 * 很容易被误判成"改坏了代码"。
 *
 * 自测的环境必须由自测自己决定，这是它还能不能当验收依据的前提。
 */
function gatewayEnv(extra = {}) {
  return {
    // 先铺一层真实环境（子进程仍需要 PATH / NODE_OPTIONS 之类）
    ...process.env,
    // 再覆盖成"自测专用"的配置 —— 顺序不能反
    CMG_DATA_DIR: dataDir,
    CMG_HOST: '127.0.0.1',
    /** 自测要能自助注册：注册这条路不通，后面几十条用例全会被挡住 */
    CMG_ALLOW_SELF_REGISTER: '1',
    CMG_REGISTER_INVITE_CODE: '',
    CMG_SMS_PROVIDER: 'console',
    /* 商店信息用固定的假数据，别把开发机上真实的微信/邮箱带进断言 */
    CMG_STORE_URL: 'https://example.com/buy',
    CMG_STORE_WECHAT: 'canmouguan',
    CMG_STORE_QQ: '',
    CMG_STORE_EMAIL: '',
    CMG_STORE_NOTE: '拍下后备注手机号',
    CMG_PRICE_MONTH: '49',
    /* 发卡回调：平台商品 ID 与套餐类型是两套命名，映射必须走配置 */
    CMG_PAYHOOK_TOKEN: 'test-hook-token',
    CMG_PAYHOOK_PRODUCTS: 'sku-month=month,sku-year=year',
    CMG_PAYHOOK_MAX_COUNT: '20',
    // 覆盖项放最后
    ...extra
  }
}

async function api(method, p, { token, body, raw, contentType, base } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  let payload
  if (raw) {
    payload = raw
    if (contentType) headers['Content-Type'] = contentType
  } else if (body !== undefined) {
    payload = JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch((base || BASE) + p, { method, headers, body: payload })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON（例如 402 的纯文本） */
  }
  return { status: res.status, json, text }
}

async function waitForHealth(base = BASE, timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${base}/health`)
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(200)
  }
  return false
}

;(async () => {
  mock = await startMockUpstream()
  console.log(`[selftest] 假上游 ${mock.port}，网关 ${PORT}`)
  console.log(`[selftest] 数据目录 ${dataDir}\n`)

  gateway = spawn(
    process.execPath,
    [path.join(SERVER_DIR, 'index.js')],
    {
      env: gatewayEnv({
        CMG_PORT: String(PORT),
        CMG_DASHSCOPE_API_KEY: 'test-dashscope-key',
        CMG_DASHSCOPE_HTTP: `http://127.0.0.1:${mock.port}`,
        CMG_DASHSCOPE_WS: `ws://127.0.0.1:${mock.port}/api-ws/v1/inference/`,
        CMG_LLM_API_KEY: 'test-llm-key',
        CMG_LLM_BASE_URL: `http://127.0.0.1:${mock.port}`,
        // 把 pro 额度压到很小，才好在几步之内测出"耗尽 → 熔断"
        CMG_PRO_ASR_SECONDS: String(PRO_ASR_SECONDS),
        CMG_PRO_LLM_CALLS: String(PRO_LLM_CALLS)
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  const gwLog = []
  gateway.stdout.on('data', (d) => gwLog.push('[gw] ' + d.toString().trim()))
  gateway.stderr.on('data', (d) => gwLog.push('[gw!] ' + d.toString().trim()))

  /**
   * 从网关日志里抓验证码。
   *
   * 为什么靠日志抓而不是加个测试接口：本机 console 通道**唯一的作用**就是把码打出来，
   * 抓日志等于顺带验证了"通道确实被调用、码确实被发出去"，
   * 而测试专用后门会绕过这条路径，反而测不到东西。
   */
  async function waitForSmsCode(phone, purpose, timeoutMs = 3000) {
    const label = purpose === 'register' ? '注册' : '登录'
    const re = new RegExp(`${phone} → (\\d{6})（${label}用`)
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const hit = re.exec(gwLog.join('\n'))
      if (hit) return hit[1]
      await sleep(50)
    }
    return ''
  }

  /** 造一个"一定不对"的 6 位码（不能等于真码，否则断言会假通过） */
  function wrongCode(code) {
    const n = Number(code)
    const wrong = String((n + 1) % 1000000).padStart(6, '0')
    return wrong === code ? '000000' : wrong
  }

  const dumpAndExit = (code) => {
    try {
      gateway.kill()
    } catch {
      /* noop */
    }
    try {
      if (gateway2) gateway2.kill()
    } catch {
      /* noop */
    }
    try {
      mock.server.close()
    } catch {
      /* noop */
    }
    const failed = results.filter(([, p]) => p === false).length
    if (failed) {
      console.log('\n--- 网关日志（排查用）---')
      for (const l of gwLog.slice(-60)) console.log('  ' + l)
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* noop */
    }
    // 打印总项数：只写"OK"的话，改动时不小心**删掉**一条断言是看不出来的
    console.log(
      failed
        ? `\nSELFTEST_FAIL（共 ${results.length} 项，${failed} 项未通过）`
        : `\nSELFTEST_OK（共 ${results.length} 项）`
    )
    process.exit(code)
  }

  const watchdog = setTimeout(() => {
    console.log('FAIL 自测超时（120s）')
    check('自测在 120s 内跑完', false)
    dumpAndExit(1)
  }, 120000)

  try {
    /* ---------------------------- 1. 启动 ---------------------------- */
    const alive = await waitForHealth()
    check('网关能启动并响应 /health', alive)
    if (!alive) {
      clearTimeout(watchdog)
      return dumpAndExit(1)
    }
    const health = await api('GET', '/health')
    check('上游密钥已从环境变量注入', health.json?.upstream?.asr === true && health.json?.upstream?.llm === true)

    /* -------------------------- 2. 注册登录 -------------------------- */
    const reg = await api('POST', '/api/auth/register', { body: { account: 'tester1', password: 'secret123' } })
    check('注册成功', reg.status === 200 && reg.json?.ok === true, reg.json?.message || `status=${reg.status}`)
    const token = reg.json?.token
    check('注册返回 token', typeof token === 'string' && token.startsWith('v1.'))
    check('新用户初始为未开通（产品已无免费套餐）', reg.json?.me?.plan === 'none', `plan=${reg.json?.me?.plan}`)
    check(
      '未开通账号额度恒为 0',
      reg.json?.me?.asr?.limit === 0 && reg.json?.me?.llm?.limit === 0,
      `asr=${reg.json?.me?.asr?.limit} llm=${reg.json?.me?.llm?.limit}`
    )
    check(
      '未开通 ≠ 已到期（expired 必须为 false）',
      reg.json?.me?.paidActive === false && reg.json?.me?.expired === false,
      `paidActive=${reg.json?.me?.paidActive} expired=${reg.json?.me?.expired}`
    )

    const dup = await api('POST', '/api/auth/register', { body: { account: 'tester1', password: 'secret123' } })
    check('重复账号注册被拒（409）', dup.status === 409 && dup.json?.reason === 'account_taken')

    const badLogin = await api('POST', '/api/auth/login', { body: { account: 'tester1', password: 'wrongpass' } })
    check('错误密码登录被拒（401）', badLogin.status === 401 && badLogin.json?.reason === 'bad_credentials')

    const login = await api('POST', '/api/auth/login', { body: { account: 'tester1', password: 'secret123' } })
    check('正确密码可登录', login.status === 200 && typeof login.json?.token === 'string')

    const noAuth = await api('GET', '/api/me')
    check('无 token 访问 /api/me 被拒（401）', noAuth.status === 401)
    const badToken = await api('GET', '/api/me', { token: 'v1.bogus.bogus' })
    check('伪造 token 被拒（401）', badToken.status === 401)

    /* ---------------------- 3. 未开通：一步都不放行 ----------------------
       这是"去掉免费体验"之后最关键的一条不变量：
       注册只给账号、**不给任何额度**，所以未开通的账号连一次请求都不该被放行。
       改造前这里会回落到 30 分钟免费语音 + 50 次提问 —— 那条白用的路径必须彻底消失，
       所以这几条断言要同时钉住"被拒""文案说的是未开通""请求没打到上游"三件事。 */
    const blockedLlm0 = await api('POST', '/v1/chat/completions', {
      token,
      body: { messages: [{ role: 'user', content: 'x' }], stream: false }
    })
    check(
      '未开通账号提问被拒（402）',
      blockedLlm0.status === 402 && blockedLlm0.json?.reason === 'llm_quota_exhausted',
      `status=${blockedLlm0.status} reason=${blockedLlm0.json?.reason}`
    )
    check(
      '拒绝文案指向"未开通"而不是"额度用完"',
      /尚未开通会员/.test(blockedLlm0.json?.message || ''),
      blockedLlm0.json?.message
    )
    check('被拒的提问没有打到上游', mock.state.llmCalls === 0, `calls=${mock.state.llmCalls}`)

    const b0 = '----cmgunpaid0'
    const blockedAsr0 = await api('POST', '/v1/audio/transcriptions', {
      token,
      raw: makeMultipart(b0, makeWav(0.5)),
      contentType: `multipart/form-data; boundary=${b0}`
    })
    check(
      '未开通账号文件转写同样被拒（402）',
      blockedAsr0.status === 402 && blockedAsr0.json?.reason === 'asr_quota_exhausted',
      `status=${blockedAsr0.status} reason=${blockedAsr0.json?.reason}`
    )
    check('被拒的转写没有打到上游', mock.state.asrFileCalls === 0, `calls=${mock.state.asrFileCalls}`)

    /* ------------------------- 4. 兑换码校验 ------------------------- */
    const badCode = await api('POST', '/api/redeem', { token, body: { code: 'CMG-22222-33333-44444' } })
    check('不存在的兑换码被拒', badCode.status === 400 && badCode.json?.reason === 'not_found')
    const malformed = await api('POST', '/api/redeem', { token, body: { code: 'abc' } })
    check('格式错误的兑换码被拒', malformed.status === 400 && malformed.json?.reason === 'invalid_format')

    /* --------------------- 5. 兑换开通（真实发码通路） ---------------------
       未开通的账号什么都干不了，所以"能用"这件事必须先有一张码。
       这里刻意走**真实的运营命令**（bin/issue.js）而不是直接改库 ——
       要验的正是"运营发出去的码，用户能兑成会员"这条闭环。
       它必须排在所有消耗额度的用例**之前**：产品没有免费额度，
       没有这一步，后面每一条都会被 402 挡住。 */
    const redeemCliOut = await new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(SERVER_DIR, 'bin', 'issue.js'), 'issue', 'month', '2'], {
        env: gatewayEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let out = ''
      p.stdout.on('data', (d) => (out += d.toString()))
      p.stderr.on('data', (d) => (out += d.toString()))
      p.on('close', () => resolve(out))
    })
    const codes = [...redeemCliOut.matchAll(/CMG-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}/g)].map((m) => m[0])
    check('CLI 能生成兑换码', codes.length === 2, `codes=${codes.length}`)

    if (codes.length >= 1) {
      const r1 = await api('POST', '/api/redeem', { token, body: { code: codes[0] } })
      check('兑换码核销成功', r1.status === 200 && r1.json?.ok === true, r1.json?.message || '')
      check('兑换后从"未开通"变成 pro', r1.json?.me?.plan === 'pro', `plan=${r1.json?.me?.plan}`)
      check('兑换后 expired 归位为 false', r1.json?.me?.expired === false, `expired=${r1.json?.me?.expired}`)
      check(
        '兑换后额度按 pro 配置生效',
        r1.json?.me?.asr?.limit === PRO_ASR_SECONDS && r1.json?.me?.llm?.limit === PRO_LLM_CALLS,
        `asr=${r1.json?.me?.asr?.limit} llm=${r1.json?.me?.llm?.limit}`
      )
      check(
        '兑换后立即可再次录音（额度已恢复）',
        r1.json?.me?.asr?.remaining === PRO_ASR_SECONDS,
        `remaining=${r1.json?.me?.asr?.remaining}`
      )

      const again = await api('POST', '/api/redeem', { token, body: { code: codes[0] } })
      check('同一兑换码不能重复使用', again.status === 400 && again.json?.reason === 'already_redeemed')

      if (codes.length >= 2) {
        const r2 = await api('POST', '/api/redeem', {
          token,
          body: { code: ` ${codes[1].toLowerCase().replace(/-/g, ' ')} ` }
        })
        check(
          '兑换码容错解析（小写 + 空格）且为续期',
          r2.status === 200 && r2.json?.redeemed?.extended === true,
          r2.json?.message || r2.text.slice(0, 120)
        )
      }
    }

    /* --------------------------- 6. LLM 流式 --------------------------- */
    const llm1 = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'glm-4-flash', messages: [{ role: 'user', content: 'hi' }], stream: true })
    })
    check('LLM 代理返回 200 且是 SSE', llm1.status === 200 && /event-stream/.test(llm1.headers.get('content-type') || ''))

    // 逐块读取，顺便验证"没有被缓冲"：中途就应该能拿到内容
    const reader = llm1.body.getReader()
    const decoder = new TextDecoder()
    let sse = ''
    let gotEarly = false
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      sse += decoder.decode(value, { stream: true })
      if (!gotEarly && sse.includes('"content"')) gotEarly = true
    }
    check('SSE 内容完整透传', sse.includes('流式回答') || sse.split('content').length > 5)
    check('流式过程中就能收到数据（未被缓冲）', gotEarly)
    check('上游确实被调用了一次', mock.state.llmCalls === 1, `calls=${mock.state.llmCalls}`)

    const afterLlm = await api('GET', '/api/me', { token })
    check('LLM 调用后额度被扣减', afterLlm.json?.me?.llm?.used === 1, `used=${afterLlm.json?.me?.llm?.used}`)
    check('上游收到的是白名单内的默认模型', mock.state.lastLlmModel === 'glm-4-flash', `model=${mock.state.lastLlmModel}`)
    check('token 用量被回填（来自上游 usage）', (afterLlm.json?.me?.llm?.tokens ?? 0) >= 42, `tokens=${afterLlm.json?.me?.llm?.tokens}`)

    // 故意传一个不在白名单里的昂贵模型：网关应该**改写**成默认模型，而不是透传
    const llm2 = await api('POST', '/v1/chat/completions', {
      token,
      body: { model: 'gpt-4-turbo-very-expensive', messages: [{ role: 'user', content: 'x' }], stream: false }
    })
    check('第二次 LLM 调用仍可用（非流式分支）', llm2.status === 200 && !!llm2.json?.choices, `status=${llm2.status}`)
    check(
      '非白名单模型被改写而非透传（防止用贵模型刷额度）',
      mock.state.lastLlmModel === 'glm-4-flash',
      `上游收到 model=${mock.state.lastLlmModel}`
    )

    const llm3 = await api('POST', '/v1/chat/completions', {
      token,
      body: { messages: [{ role: 'user', content: 'x' }], stream: false }
    })
    check(
      '额度耗尽后 LLM 被拦截（402）',
      llm3.status === 402 && llm3.json?.reason === 'llm_quota_exhausted',
      `status=${llm3.status} reason=${llm3.json?.reason}`
    )
    check('被拦截的请求没有打到上游', mock.state.llmCalls === 2, `calls=${mock.state.llmCalls}`)

    /* -------------------------- 7. 文件转写 -------------------------- */
    const boundary = '----cmgtestboundary'
    const wav = makeWav(0.5)
    const mp = makeMultipart(boundary, wav)
    const asrFile = await api('POST', '/v1/audio/transcriptions', {
      token,
      raw: mp,
      contentType: `multipart/form-data; boundary=${boundary}`
    })
    check('文件转写返回 200', asrFile.status === 200, `status=${asrFile.status} ${asrFile.text.slice(0, 120)}`)
    check('转写文本被透传回来', (asrFile.json?.text || '').includes('假上游'))
    check('上游确实收到文件转写请求', mock.state.asrFileCalls === 1, `calls=${mock.state.asrFileCalls}`)
    check('白名单内的模型被原样转发', mock.state.asrFileModel === 'paraformer-v2', `model=${mock.state.asrFileModel}`)

    const afterFile = await api('GET', '/api/me', { token })
    const usedAfterFile = afterFile.json?.me?.asr?.used ?? 0
    check(
      '按 WAV 头解析出的真实时长计费（0.5s 而非估算）',
      usedAfterFile >= 0 && usedAfterFile <= 1,
      `used=${usedAfterFile}s`
    )

    /* -------------------------- 8. 实时转写（正常） -------------------------- */
    const sr = 16000

    /**
     * 开一条实时连接，发指定秒数的 PCM，返回看到的事件序列。
     * @param seconds 要发送的音频秒数
     * @param timeoutMs 等多久放弃
     */
    const runRealtime = (seconds, timeoutMs = 10000) =>
      new Promise((resolve) => {
        const frames = pcmFrames(seconds)
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/asr/realtime`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        const seen = []
        let failure = ''
        let opened = false
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          try {
            ws.close()
          } catch {
            /* noop */
          }
          resolve({ connected: opened, seen, failure })
        }
        ws.on('open', () => {
          opened = true
          ws.send(
            JSON.stringify({
              header: { action: 'run-task', task_id: 'test', streaming: 'duplex' },
              payload: {
                task_group: 'audio',
                task: 'asr',
                function: 'recognition',
                model: 'paraformer-realtime-v2',
                input: {},
                parameters: { format: 'pcm', sample_rate: sr }
              }
            })
          )
        })
        ws.on('message', (data, isBinary) => {
          if (isBinary) return
          let msg = null
          try {
            msg = JSON.parse(data.toString('utf8'))
          } catch {
            return
          }
          seen.push(msg?.header?.event)
          if (msg?.header?.event === 'task-started') {
            for (const f of frames) ws.send(f, { binary: true })
            ws.send(
              JSON.stringify({
                header: { action: 'finish-task', task_id: 'test', streaming: 'duplex' },
                payload: { input: {} }
              })
            )
          }
          if (msg?.header?.event === 'task-finished' || msg?.header?.event === 'task-failed') {
            failure = msg?.header?.error_message || ''
            finish()
          }
        })
        ws.on('error', (e) => {
          failure = e.message
          finish()
        })
        setTimeout(finish, timeoutMs)
      })

    const rtResult = await runRealtime(1) // 1 秒，额度 3 秒够用
    check('实时转写 WS 能连上并完成握手', rtResult.connected === true, rtResult.failure || '')
    check('task-started 被透传给客户端', rtResult.seen.includes('task-started'))
    check('task-finished 被透传给客户端', rtResult.seen.includes('task-finished'))
    check('上游没有报错', !rtResult.failure, rtResult.failure || '')
    check('PCM 音频字节被中继到上游', mock.state.realtimeBytes >= 3200, `bytes=${mock.state.realtimeBytes}`)

    await sleep(300)
    const afterRt = await api('GET', '/api/me', { token })
    const usedAfterRt = afterRt.json?.me?.asr?.used ?? 0
    check('实时转写按音频时长计费（约 1 秒）', usedAfterRt >= 1, `累计 used=${usedAfterRt}s`)

    /* ------------------ 9. 实时中途超额：必须熔断 ------------------ */
    // 此时剩余约 1.5 秒，故意发 3 秒 —— 应该在 ~1.5 秒处被服务端掐断
    const overrun = await runRealtime(3)
    check('超额时收到 task-failed（熔断生效）', overrun.seen.includes('task-failed'), `events=${overrun.seen.join(',')}`)
    check('熔断原因是额度耗尽', /额度/.test(overrun.failure), overrun.failure || '(无消息)')

    await sleep(400)
    const afterOver = await api('GET', '/api/me', { token })
    check('熔断后语音额度归零', (afterOver.json?.me?.asr?.remaining ?? -1) === 0, `remaining=${afterOver.json?.me?.asr?.remaining}`)

    /* ------------------ 10. 额度耗尽后新连接被拒 ------------------ */
    const blocked = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/asr/realtime`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      let settled = false
      const done = (v) => {
        if (settled) return
        settled = true
        resolve(v)
      }
      ws.on('unexpected-response', (_req, res) => done({ status: res.statusCode }))
      ws.on('open', () => done({ status: 101 }))
      ws.on('error', (e) => done({ status: e.code || 'error', message: e.message }))
      setTimeout(() => done({ status: 'timeout' }), 6000)
    })
    check('语音额度耗尽后实时通道被拒（402）', blocked.status === 402, `status=${blocked.status}`)

    /* ---------------------- 11. 注册即带码开通 ---------------------- */
    const out2 = await new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(SERVER_DIR, 'bin', 'issue.js'), 'issue', 'month', '1'], {
        env: gatewayEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let o = ''
      p.stdout.on('data', (d) => (o += d.toString()))
      p.on('close', () => resolve(o))
    })
    const code2 = (out2.match(/CMG-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}/) || [])[0]
    const reg2 = await api('POST', '/api/auth/register', {
      body: { account: 'tester2', password: 'secret123', code: code2 }
    })
    check('注册时直接带兑换码可开通', reg2.status === 200 && reg2.json?.redeemed != null, reg2.json?.message || '')
    check('开通后即为 pro', reg2.json?.me?.plan === 'pro', `plan=${reg2.json?.me?.plan}`)

    /* ---------------------- 12. 停用账号立刻失效 ---------------------- */
    const { DatabaseSync } = require('node:sqlite')
    const direct = new DatabaseSync(path.join(dataDir, 'gateway.db'))
    direct.prepare('UPDATE users SET disabled = 1 WHERE account = ?').run('tester2')
    direct.close()
    const disabled = await api('GET', '/api/me', { token: reg2.json?.token })
    check('账号被停用后 token 立刻失效（无需等过期）', disabled.status === 401, `status=${disabled.status}`)

    /* ------------------ 13. 手机号注册 / 登录（console 通道） ------------------ */
    const PHONE = '13800001111'

    const badPhone = await api('POST', '/api/auth/sms/send', { body: { phone: '12345', purpose: 'register' } })
    check('非法手机号被拒（400）', badPhone.status === 400 && badPhone.json?.reason === 'invalid_phone')

    const sent1 = await api('POST', '/api/auth/sms/send', { body: { phone: PHONE, purpose: 'register' } })
    check('验证码下发成功', sent1.status === 200 && sent1.json?.sent === true, sent1.json?.message || `status=${sent1.status}`)
    check('本机 console 通道被正确选中', sent1.json?.provider === 'console', `provider=${sent1.json?.provider}`)

    const code1 = await waitForSmsCode(PHONE, 'register')
    check('验证码真的经通道发出（日志可见）', /^\d{6}$/.test(code1), `code=${code1 || '(未捕获)'}`)

    // 冷却用"上一条码的发送时间"判断，所以发送失败时不会白等（见 13 段末）
    const tooSoon = await api('POST', '/api/auth/sms/send', { body: { phone: PHONE, purpose: 'register' } })
    check('重发冷却生效（429）', tooSoon.status === 429 && tooSoon.json?.reason === 'too_soon', `status=${tooSoon.status}`)
    check('冷却拒绝时带上剩余等待时间', (tooSoon.json?.retryAfterMs ?? 0) > 0, `retryAfterMs=${tooSoon.json?.retryAfterMs}`)

    const wrong1 = await api('POST', '/api/auth/register', {
      body: { phone: PHONE, password: 'secret123', smsCode: wrongCode(code1) }
    })
    check('错误验证码被拒（400）', wrong1.status === 400 && wrong1.json?.reason === 'code_wrong', `reason=${wrong1.json?.reason}`)
    check('错误验证码提示剩余可试次数', /还可尝试 4 次/.test(wrong1.json?.message || ''), wrong1.json?.message)

    // 这条同时证明"校验在所有前置检查之后"：密码不合格时不会消耗掉验证码
    const weak = await api('POST', '/api/auth/register', { body: { phone: PHONE, password: '123', smsCode: code1 } })
    check('手机号注册必须设置够长度的密码', weak.status === 400 && weak.json?.reason === 'weak_password')

    const regPhone = await api('POST', '/api/auth/register', {
      body: { phone: PHONE, password: 'secret123', smsCode: code1 }
    })
    check('手机号注册成功', regPhone.status === 200 && regPhone.json?.ok === true, regPhone.json?.message || `status=${regPhone.status}`)
    check('未传 account 时手机号即账号', regPhone.json?.me?.account === PHONE, `account=${regPhone.json?.me?.account}`)

    const dupPhone = await api('POST', '/api/auth/register', {
      body: { phone: PHONE, password: 'secret123', smsCode: code1 }
    })
    check('同手机号重复注册被拒（409）', dupPhone.status === 409 && dupPhone.json?.reason === 'phone_taken')

    // 验证码绑定手机号：换一个号拿同一个码注册必须失败
    const crossPhone = await api('POST', '/api/auth/register', {
      body: { phone: '13800002222', password: 'secret123', smsCode: code1 }
    })
    check('验证码与手机号绑定，换号不可用', crossPhone.json?.reason === 'code_missing', `reason=${crossPhone.json?.reason}`)

    const loginPwd = await api('POST', '/api/auth/login', { body: { phone: PHONE, password: 'secret123' } })
    check('手机号 + 密码可登录', loginPwd.status === 200 && typeof loginPwd.json?.token === 'string')
    const loginByAccount = await api('POST', '/api/auth/login', { body: { account: PHONE, password: 'secret123' } })
    check('把手机号填在账号框里也能登录', loginByAccount.status === 200, `status=${loginByAccount.status}`)
    const wrongPwd = await api('POST', '/api/auth/login', { body: { phone: PHONE, password: 'nope123' } })
    check('手机号 + 错误密码被拒（401）', wrongPwd.status === 401 && wrongPwd.json?.reason === 'bad_credentials')

    const sentLogin = await api('POST', '/api/auth/sms/send', { body: { phone: PHONE, purpose: 'login' } })
    check('登录验证码下发成功', sentLogin.status === 200, sentLogin.json?.message || `status=${sentLogin.status}`)
    const loginCode = await waitForSmsCode(PHONE, 'login')
    check('登录验证码已发出', /^\d{6}$/.test(loginCode), `code=${loginCode || '(未捕获)'}`)

    const loginSms = await api('POST', '/api/auth/login', { body: { phone: PHONE, smsCode: loginCode } })
    check('手机号 + 验证码可登录', loginSms.status === 200 && typeof loginSms.json?.token === 'string', loginSms.json?.message || `status=${loginSms.status}`)
    const replay = await api('POST', '/api/auth/login', { body: { phone: PHONE, smsCode: loginCode } })
    check('验证码用过即作废（不可重放）', replay.status === 401 && replay.json?.reason === 'code_missing', `reason=${replay.json?.reason}`)

    // 未注册的号：先拿到码，再看提示是否明确（先验码后才判"是否注册"，避免被拿来枚举）
    const otherPhone = '13900003333'
    await api('POST', '/api/auth/sms/send', { body: { phone: otherPhone, purpose: 'login' } })
    const otherCode = await waitForSmsCode(otherPhone, 'login')
    const notReg = await api('POST', '/api/auth/login', { body: { phone: otherPhone, smsCode: otherCode } })
    check(
      '未注册手机号用验证码登录 → 明确提示未注册',
      notReg.status === 401 && notReg.json?.reason === 'phone_not_registered',
      `reason=${notReg.json?.reason} msg=${notReg.json?.message}`
    )

    // 暴力破解闸门：错满 maxAttempts 后整条验证码作废
    const lockPhone = '13700004444'
    await api('POST', '/api/auth/sms/send', { body: { phone: lockPhone, purpose: 'login' } })
    const lockCode = await waitForSmsCode(lockPhone, 'login')
    let lastWrong = null
    for (let i = 0; i < 5; i++) {
      lastWrong = await api('POST', '/api/auth/login', { body: { phone: lockPhone, smsCode: wrongCode(lockCode) } })
    }
    check('错满 5 次后验证码作废（code_locked）', lastWrong?.json?.reason === 'code_locked', `reason=${lastWrong?.json?.reason}`)
    const afterLock = await api('POST', '/api/auth/login', { body: { phone: lockPhone, smsCode: lockCode } })
    check('锁定后连正确验证码也不放行', afterLock.status === 401 && afterLock.json?.reason === 'code_locked', `reason=${afterLock.json?.reason}`)

    /* ------------- 14. webhook 短信通道（生产实际会走的路径） ------------- */
    gateway2 = spawn(process.execPath, [path.join(SERVER_DIR, 'index.js')], {
      env: gatewayEnv({
        CMG_PORT: String(PORT2), // 同一个库 + 同一个密钥文件
        CMG_SMS_PROVIDER: 'webhook',
        CMG_SMS_WEBHOOK_URL: `http://127.0.0.1:${mock.port}/sms`,
        CMG_SMS_WEBHOOK_TOKEN: 'test-sms-token'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    gateway2.stderr.on('data', (d) => gwLog.push('[gw2!] ' + d.toString().trim()))

    const alive2 = await waitForHealth(BASE2)
    check('第二个网关实例能起来（多进程共用同一个库）', alive2)
    if (!alive2) {
      check('webhook 通道可下发', false, '网关 2 未启动')
    } else {
      const h2 = await api('GET', '/health', { base: BASE2 })
      check(
        '/health 暴露短信通道状态（排障用）',
        h2.json?.sms?.provider === 'webhook' && h2.json?.sms?.ready === true,
        JSON.stringify(h2.json?.sms)
      )

      const wPhone = '13600005555'
      const wSent = await api('POST', '/api/auth/sms/send', {
        body: { phone: wPhone, purpose: 'register' },
        base: BASE2
      })
      check(
        'webhook 通道下发成功',
        wSent.status === 200 && wSent.json?.provider === 'webhook',
        wSent.json?.message || `status=${wSent.status}`
      )

      const got = mock.state.smsSends[mock.state.smsSends.length - 1] || {}
      check(
        '验证码被送到短信服务（号码/内容/用途/时效齐全）',
        got.phone === wPhone && /^\d{6}$/.test(got.code || '') && got.purpose === 'register' && got.expiresInMinutes > 0,
        JSON.stringify(got)
      )
      check('webhook 带上了配置的鉴权头', mock.state.smsAuth === 'Bearer test-sms-token', `auth=${mock.state.smsAuth}`)

      const wReg = await api('POST', '/api/auth/register', {
        body: { phone: wPhone, password: 'secret123', smsCode: got.code },
        base: BASE2
      })
      check(
        '用 webhook 送出的验证码能完成注册',
        wReg.status === 200 && wReg.json?.ok === true,
        wReg.json?.message || `status=${wReg.status}`
      )
      const crossInstance = await api('GET', '/api/me', { token: wReg.json?.token })
      check('两实例共享同一签名密钥（gw2 发的 token gw1 认）', crossInstance.status === 200, `status=${crossInstance.status}`)

      /* 通道故障：必须明确报错，且**不能留下可用的验证码**。
         这是本层唯一一条"错了会静默卡住用户 / 静默花钱"的路径。 */
      mock.state.smsBroken = true
      const brokenPhone = '13500006666'
      const broken = await api('POST', '/api/auth/sms/send', {
        body: { phone: brokenPhone, purpose: 'register' },
        base: BASE2
      })
      check(
        '短信服务故障时明确报错，不假装已发送',
        broken.status === 502 && broken.json?.reason === 'sms_failed',
        `status=${broken.status} reason=${broken.json?.reason}`
      )
      check('报错带上上游状态码（便于排障）', /500/.test(broken.json?.message || ''), broken.json?.message)

      mock.state.smsBroken = false
      const afterFail = await api('POST', '/api/auth/register', {
        body: { phone: brokenPhone, password: 'secret123', smsCode: '000000' },
        base: BASE2
      })
      check('发送失败后库里没有残留验证码', afterFail.json?.reason === 'code_missing', `reason=${afterFail.json?.reason}`)
      const retry = await api('POST', '/api/auth/sms/send', {
        body: { phone: brokenPhone, purpose: 'register' },
        base: BASE2
      })
      check('发送失败不占用重发冷却（通道恢复后能立刻重试）', retry.status === 200, `status=${retry.status} ${retry.json?.message || ''}`)
    }

    /* ------------- 15. 发卡平台回调：自动发码（收银台的落地形态） -------------
       验的是"钱进来之后码怎么出去"。这个端点能在**没有任何账号**的前提下凭空发会员，
       所以关闭态、鉴权、幂等、未知商品这四条必须锁死。 */
    const hook = (body, token = 'test-hook-token') => api('POST', '/api/hook/card', { body, token })

    const hHealth = await api('GET', '/health')
    check(
      '健康检查暴露发卡回调状态（排障第一眼）',
      hHealth.json?.payhook?.enabled === true,
      JSON.stringify(hHealth.json?.payhook)
    )

    const hNoTok = await hook({ order_id: 'H1', sku: 'sku-month' }, '')
    check(
      '无凭据的回调被拒（不能凭空发会员）',
      hNoTok.status === 401 && hNoTok.json?.reason === 'bad_token',
      `status=${hNoTok.status}`
    )
    const hBadTok = await hook({ order_id: 'H1', sku: 'sku-month' }, 'wrong-token')
    check('错误凭据的回调被拒', hBadTok.status === 401, `status=${hBadTok.status}`)

    const hFirst = await hook({ order_id: 'HOOK-1', sku: 'sku-month', amount: 49 })
    const issued = hFirst.json?.codes?.[0] || ''
    check('回调签发兑换码', hFirst.status === 200 && /^CMG-/.test(issued), issued)
    check(
      '平台商品 ID 按配置映射成月卡',
      hFirst.json?.kind === 'month' && hFirst.json?.days === 31,
      `${hFirst.json?.kind}/${hFirst.json?.days}`
    )
    check('返回 content 供平台直接展示卡密', hFirst.json?.content === issued, hFirst.json?.content)

    const hAgain = await hook({ order_id: 'HOOK-1', sku: 'sku-month', amount: 49 })
    check(
      '同一订单重复回调返回同一批码（幂等，不会发两次）',
      hAgain.json?.code === issued && hAgain.json?.replayed === true,
      `${hAgain.json?.code} replayed=${hAgain.json?.replayed}`
    )

    const hBadSku = await hook({ order_id: 'HOOK-2', sku: 'sku-nope' })
    check(
      '未知商品被拒，且不落回默认套餐',
      hBadSku.status === 400 && hBadSku.json?.reason === 'unknown_sku',
      `reason=${hBadSku.json?.reason}`
    )
    const hNoOrder = await hook({ sku: 'sku-month' })
    check(
      '缺订单号被拒（不发无主码）',
      hNoOrder.status === 400 && hNoOrder.json?.reason === 'order_required',
      `reason=${hNoOrder.json?.reason}`
    )
    const hDirect = await hook({ order_id: 'HOOK-3', sku: 'quarter' })
    check(
      'sku 直接是类型时无需映射也能发（quarter 不在映射表里）',
      hDirect.json?.kind === 'quarter' && hDirect.json?.days === 93,
      JSON.stringify(hDirect.json)
    )
    /* 「免费体验 7 天」已下线。这个 SKU 必须变成**未知商品**被拒 ——
       否则老平台后台还挂着的商品会继续发出一批已经不该存在的类型。 */
    const hRetired = await hook({ order_id: 'HOOK-5', sku: 'trial7' })
    check(
      '已下线的 trial7 被当作未知商品拒绝',
      hRetired.status === 400 && hRetired.json?.reason === 'unknown_sku',
      `status=${hRetired.status} reason=${hRetired.json?.reason}`
    )
    const hMany = await hook({ order_id: 'HOOK-4', sku: 'month', count: 999 })
    check('单次签发数量被上限截断', hMany.json?.codes?.length === 20, `n=${hMany.json?.codes?.length}`)

    /* 端到端闭环：平台发出去的码，买家注册后真的能兑换成会员。
       这才是"能收钱"这件事成立的最低证明。 */
    const hReg = await api('POST', '/api/auth/register', {
      body: { account: 'hookbuyer@example.com', password: 'buyer-pass-123' }
    })
    const hRedeem = await api('POST', '/api/redeem', { body: { code: issued }, token: hReg.json?.token })
    check(
      '回调签发的码能兑换成会员（闭环成立）',
      hRedeem.status === 200 && hRedeem.json?.me?.plan === 'pro',
      hRedeem.json?.message || `status=${hRedeem.status}`
    )
    const hReuse = await api('POST', '/api/redeem', { body: { code: issued }, token: hReg.json?.token })
    check('同一个码不能兑换两次', hReuse.json?.ok === false, `reason=${hReuse.json?.reason}`)

    /* 套餐/价格/购买方式下发。**刻意免登录** —— 用户是先买码再注册的，
       要求先登录才能看到价格，等于把最大的那部分人挡在门外。 */
    const hPlans = await api('GET', '/api/plans')
    check('/api/plans 免登录可读（先买码后注册）', hPlans.status === 200, `status=${hPlans.status}`)
    const hMonth = (hPlans.json?.plans || []).find((p) => p.kind === 'month')
    check('价格来自配置，且与时长同源', hMonth?.price === 49 && hMonth?.days === 31, JSON.stringify(hMonth))
    check(
      '购买方式随响应下发（客户端不写死）',
      hPlans.json?.store?.purchaseUrl === 'https://example.com/buy' &&
        hPlans.json?.store?.contactWechat === 'canmouguan',
      JSON.stringify(hPlans.json?.store)
    )

    clearTimeout(watchdog)
    dumpAndExit(results.filter(([, p]) => p === false).length ? 1 : 0)
  } catch (err) {
    clearTimeout(watchdog)
    console.log('FAIL 自测异常：', err && err.stack ? err.stack : err)
    check('自测流程无异常', false)
    dumpAndExit(1)
  }
})()
