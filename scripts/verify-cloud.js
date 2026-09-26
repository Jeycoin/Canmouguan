/**
 * 探查：**客户端 ↔ 网关的真实链路**（不走 UI，直接打真代码）。
 *
 * 为什么需要它：单元测试只验"URL 算得对不对"，网关自测只验"网关自己是对的"，
 * 两者之间那条**线**没人验 —— 路径写错、鉴权头写错、SSE 被缓冲，
 * 单测和网关自测都会全绿，而用户打开就是不能用。
 *
 * 这一版刻意用**真实上游协议形状的假上游**，而不是 mock 掉 fetch：
 * 只有真的走完 HTTP / WebSocket / SSE 三条线，才能证明"能卖会员"这件事成立。
 *
 * 跑法（必须经 start-electron.js，否则会退化成纯 Node 进程）：
 *   node scripts/start-electron.js ./scripts/verify-cloud.js
 */
const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const WebSocket = require('ws')

// 这个探查不开窗口，但仍然要挡住 GPU 进程 —— 坏 GPU 环境下它会连带 FATAL 整个进程
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 网关是**纯 Node 服务**，必须用真正的 node 起，不能复用 `process.execPath`
 * （那在 Electron 里是 electron.exe，退化成 Node 后自带的 node 版本不一定带 `node:sqlite`）。
 * `npm_node_execpath` 是 npm 在跑 script 时注入的 node 路径。
 */
const NODE_BIN = process.env.npm_node_execpath || 'node'

/* ------------------------------ 断言 ------------------------------ */

const results = []
function check(desc, pass, detail = '') {
  results.push({ desc, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${desc}${detail ? `   [${detail}]` : ''}`)
}

/* --------------------------- 假上游 --------------------------- */

function startMockUpstream() {
  const state = { llmCalls: 0, lastLlmModel: '', asrFileCalls: 0, realtimeBytes: 0 }

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)

    if (req.url.startsWith('/compatible-mode/v1/audio/transcriptions')) {
      state.asrFileCalls++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ text: '这是假上游返回的转写结果' }))
    }

    if (req.url.startsWith('/chat/completions')) {
      state.llmCalls++
      let parsed = {}
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        /* ignore */
      }
      state.lastLlmModel = parsed.model || ''
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (const w of ['这', '是', '云', '端', '回', '答']) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`)
          await sleep(10)
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 12 } })}\n\n`)
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ choices: [{ message: { content: '非流式回答' } }] }))
    }

    res.writeHead(404)
    res.end('mock: not found')
  })

  const wss = new WebSocket.Server({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
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

/* --------------------------- 工具 --------------------------- */

/** PCM16 16kHz 单声道 WAV，带真实波形（全零会被当成静音） */
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
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 440 * Math.PI * 2) * 8000), 44 + i * 2)
  }
  return buf
}

async function waitForHealth(base, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  return false
}

/** 探针要起自己的网关，端口不能写死：失败的上一轮可能还占着它 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/**
 * 从网关日志里捞出刚发出去的验证码。
 *
 * 为什么不去改网关加一个"查验证码"的接口：那等于在生产代码里开一个后门，
 * 只为了让测试方便。日志里本来就有（console 通道的设计目的就是自测），
 * 从日志抓既不用改产品代码，又顺带证明了**短信通道真的被调用了**。
 *
 * 取**最后一条**匹配：同一个号码会先后拿到注册码与登录码。
 *
 * ⚠️ 第一个参数必须是**取值函数**而不是日志字符串本身 —— 传字符串会拿到一份快照，
 * 轮询时永远看不到新追加的日志，只会静静等到超时然后返回空。
 */
function waitForSmsCode(readLog, phone, timeoutMs = 5000) {
  const re = new RegExp(`\\[短信·本机通道\\] ${phone} → (\\d{6})`, 'g')
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const poll = () => {
      const all = [...readLog().matchAll(re)]
      if (all.length) return resolve(all[all.length - 1][1])
      if (Date.now() > deadline) return resolve('')
      setTimeout(poll, 100)
    }
    poll()
  })
}

/** 造一个**格式合法但一定不对**的 6 位码，用来验"错误码不能放行" */
function wrongCode(code) {
  return String((Number(code) + 1) % 1000000).padStart(6, '0')
}

/**
 * 跑一次运营 CLI 并拿回输出。
 *
 * 用异步 `spawn` 而不是 `spawnSync`：在 Electron 主进程里 `spawnSync` 会直接
 * 以 `EBUSY` 失败（连子进程都没起来），而同样的命令在终端里跑得好好的 ——
 * 这是探查环境的坑，不是 CLI 的问题。
 */
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(NODE_BIN, [path.join(ROOT, 'server', 'bin', 'issue.js'), ...args], {
      env: { ...process.env, ...env },
      cwd: ROOT
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => resolve({ out, err: `${err} spawn-error:${e.code || e.message}` }))
    child.on('close', () => resolve({ out, err }))
  })
}

/* --------------------------- 主流程 --------------------------- */

async function main() {
  // 临时 userData：settings.json 里有加密 Key，绝不碰用户的真实数据
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cmg-cloud-probe-'))
  process.env.CANMOUGUAN_USER_DATA = userData
  require(path.join(ROOT, 'dist-electron/main/appdir.js')).pinUserDataDir()

  const store = require(path.join(ROOT, 'dist-electron/main/store.js'))
  const cloud = require(path.join(ROOT, 'dist-electron/main/cloud.js'))
  const llm = require(path.join(ROOT, 'dist-electron/main/llm.js'))
  const stt = require(path.join(ROOT, 'dist-electron/main/stt.js'))

  const mock = await startMockUpstream()
  const gwData = fs.mkdtempSync(path.join(os.tmpdir(), 'cmg-cloud-gw-'))
  const PORT = await pickFreePort()
  const BASE = `http://127.0.0.1:${PORT}`

  const gw = spawn(NODE_BIN, [path.join(ROOT, 'server', 'index.js')], {
    // 宿主 IDE 会注入 ELECTRON_RUN_AS_NODE=1；对真 node 无害，但显式清掉更干净
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      CMG_DATA_DIR: gwData,
      CMG_HOST: '127.0.0.1',
      CMG_PORT: String(PORT),
      CMG_DASHSCOPE_API_KEY: 'test-dashscope-key',
      CMG_DASHSCOPE_HTTP: `http://127.0.0.1:${mock.port}`,
      CMG_DASHSCOPE_WS: `ws://127.0.0.1:${mock.port}/api-ws/v1/inference/`,
      CMG_LLM_API_KEY: 'test-llm-key',
      CMG_LLM_BASE_URL: `http://127.0.0.1:${mock.port}`,
      CMG_LLM_MODEL: 'glm-4-flash',
      CMG_ALLOW_SELF_REGISTER: '1',
      /**
       * ⚠️ 显式清空邀请码。
       *
       * 网关启动时会加载 `server/.env`（`loadDotEnv` 只在变量**未定义**时才跳过），
       * 开发机上那份真实配置会渗进探针。踩过一次：`.env` 里一句
       * `CMG_ALLOW_SELF_REGISTER=0` 就让整套注册链路全线失败。这里已经显式写了 `'1'`，
       * 邀请码同样要显式写死，否则将来 `.env` 里一加它，探针又会莫名其妙挂掉。
       */
      CMG_REGISTER_INVITE_CODE: '',
      /* 额度用默认值即可：本探针注册时带码（= pro），跑的是"有额度时链路通不通"。
         要验"未开通/耗尽被拦"那类判定，看 server/test/selftest.js。 */
      // 短信走本机 console 通道：验证码打进网关日志，探针从日志里捞（见 waitForSmsCode）。
      // 这正好也验证了"通道真的被调用了"，而不只是"接口回了 ok"。
      CMG_SMS_PROVIDER: 'console',
      CMG_SMS_RESEND_SECONDS: '60'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  /**
   * 网关日志同时做两件事：打在屏幕上给人看，以及**留在 gwLog 里给 waitForSmsCode 抓码**。
   * 不去解析 stdout 管道、也不改网关代码加一个"查询验证码"接口 ——
   * 后者等于在生产代码里开一个后门，只为了让测试方便。
   */
  let gwLog = ''
  gw.stdout.on('data', (d) => {
    gwLog += d
    process.stdout.write(`  [gw] ${d}`)
  })
  gw.stderr.on('data', (d) => process.stdout.write(`  [gw:err] ${d}`))

  try {
    const up = await waitForHealth(BASE)
    check('网关已启动并健康', up, BASE)
    if (!up) throw new Error('网关未能在超时内启动')

    /* ---------- 1. 发一张兑换码（用真实运营 CLI，而不是直接写库） ---------- */
    const issued = await runCli(['issue', 'month', '1'], { CMG_DATA_DIR: gwData })
    const code = (issued.out || '').match(/CMG-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/)?.[0] || ''
    check('运营 CLI 能发出兑换码', Boolean(code), code || (issued.err || issued.out || '').trim().slice(0, 160))

    /* ---------- 2. 客户端配置 + 注册（带码） ---------- */
    store.patchSettings({ cloud: { enabled: true, baseURL: BASE } })
    check('网关地址规范化（无尾斜杠）', cloud.cloudBaseURL() === BASE, cloud.cloudBaseURL())

    const reg = await cloud.register({
      account: 'probe@example.com',
      password: 'probe-pass-123',
      code
    })
    check('客户端注册成功并拿到额度快照', Boolean(reg.me), reg.me ? `${reg.me.planName} asr=${reg.me.asr.limit}s` : '')
    check('注册时带的兑换码直接生效（专业版）', reg.me?.plan === 'pro', reg.me?.plan || '')
    check('token 已落盘（渲染层拿不到，只有主进程能解密）', Boolean(store.getSettings().cloud.tokenEnc))
    check('已登录判定为真', cloud.cloudLoggedIn() === true)

    /* ---------- 3. 落点解析：三条链路都指向网关 ---------- */
    // 注意 asrConn() **不接受任何参数** —— 这是刻意的：调用方没机会把自己的凭据塞进去。
    const conn = cloud.asrConn()
    check('实时转写落点指向网关', conn.wsUrl.startsWith(BASE.replace(/^http/, 'ws') + '/v1/asr/realtime'), conn.wsUrl.replace(/token=.*/, 'token=<hidden>'))
    check('文件转写落点指向网关', conn.httpUrl === `${BASE}/v1/audio/transcriptions`, conn.httpUrl)
    const target = cloud.llmTarget({ model: 'glm-4-flash', visionModel: 'glm-4v-flash' })
    check('大模型落点指向网关 /v1', target?.baseURL === `${BASE}/v1`, target?.baseURL || '')
    check('大模型模型名在白名单内', target?.model === 'glm-4-flash', target?.model || '')

    /* ---------- 4. 真打一次 LLM（SSE 必须真流式到达） ---------- */
    let chunks = 0
    let full = ''
    await new Promise((resolve, reject) => {
      llm
        .streamChat(
          { messages: [{ role: 'user', content: '只回复两个字：ok' }] },
          {
            onDelta: (d) => {
              chunks++
              full += d
            },
            onDone: () => resolve(),
            onError: (m) => reject(new Error(m))
          }
        )
        .catch(reject)
    })
    check('经网关的流式回答完整到达', full === '这是云端回答', full)
    check('流式是真·逐包到达（中间层没做缓冲）', chunks >= 4, `chunks=${chunks}`)
    check('网关按白名单改写了模型（上游收到的是默认模型）', mock.state.lastLlmModel === 'glm-4-flash', mock.state.lastLlmModel)

    /* ---------- 5. 真打一次文件转写（计费时长由 WAV 头决定） ---------- */
    const wav = makeWav(2)
    const text = await stt.transcribeFile(conn, { ...store.getSettings().stt, model: 'paraformer-v2' }, wav, 0)
    check('经网关的文件转写返回结果', text === '这是假上游返回的转写结果', text)

    /* ---------- 6. 真打一次实时转写（WS 握手 + 双向透传 + 计量） ---------- */
    const rtSettings = { ...store.getSettings().stt, model: 'paraformer-realtime-v2' }
    const rt = new stt.DashScopeRealtime(conn, rtSettings)
    let rtError = ''
    rt.on('error', (m) => {
      rtError = m
    })
    let handshakeOk = true
    try {
      await rt.start(0)
    } catch (err) {
      handshakeOk = false
      rtError = rtError || err.message
    }
    check('实时转写能连上网关并完成握手', handshakeOk, rtError)
    if (handshakeOk) {
      // 送 3 秒音频：网关按 bytes/(16000*2) 计量
      rt.sendAudio(Buffer.alloc(16000 * 2 * 3))
      await sleep(120)
      const rtText = await rt.finish()
      check('实时转写结果被透传回客户端', rtText.includes('实时转写结果'), rtText)
      check('网关记录了实时音频字节数', mock.state.realtimeBytes > 0, `bytes=${mock.state.realtimeBytes}`)
    }

    /* ---------- 7. 额度真的被扣了 ---------- */
    const me = await cloud.refreshMe()
    check('额度快照已回写设置', Boolean(store.getSettings().cloud.lastMe))
    check('语音额度按实际用量扣减', Boolean(me && me.asr.used > 0), me ? `used=${Math.round(me.asr.used)}s` : '')
    check('提问次数至少记了 1 次', Boolean(me && me.llm.used >= 1), me ? `used=${me.llm.used}` : '')

    /* ---------- 8. 凭据的边界行为 ---------- */
    // 注意：不能靠 patch 清 token —— `patchSettings` 故意保住它（防止渲染层误清）。
    // 唯一的清除入口就是登出，这里正好顺带验证这条纪律。
    store.patchSettings({ cloud: { enabled: true, baseURL: BASE, tokenEnc: undefined } })
    check('patch 通道无法清空 token（凭据只走专门入口）', Boolean(store.getSettings().cloud.tokenEnc))

    cloud.logout()
    check('登出后清理了本地凭据', !store.getSettings().cloud.tokenEnc && cloud.cloudLoggedIn() === false)

    let noTokenErr = ''
    try {
      cloud.asrConn()
    } catch (err) {
      noTokenErr = err.message
    }
    check('未登录时不拿空 token 去请求，而是给出可执行提示', noTokenErr.includes('登录'), noTokenErr)

    // 换成一个无效 token：网关握手应被拒，且客户端要给出"重新登录"这类可读提示
    const forged = store.getSettings()
    forged.cloud.tokenEnc = store.encryptSecret('v1.garbage.sig')
    store.saveSettings(forged)
    const badRt = new stt.DashScopeRealtime(cloud.asrConn(), rtSettings)
    let badMsg = ''
    badRt.on('error', (m) => {
      badMsg = m
    })
    await badRt.start(0).catch(() => {})
    check('无效 token 被网关拒绝且提示可读', /登录|拒绝|401/.test(badMsg), badMsg)

    /* ---------- 9. 手机号路径：注册 / 验证码登录 / 密码登录 ---------- */
    cloud.logout()
    const PHONE = '13800001234'

    const send1 = await cloud.sendSmsCode(PHONE, 'register')
    check(
      '手机号注册：验证码能下发（本机 console 通道）',
      send1.provider === 'console' && send1.ttlMinutes > 0,
      `provider=${send1.provider} ttl=${send1.ttlMinutes}min`
    )
    check('下发结果带回重发冷却，客户端不必自编秒数', send1.resendAfterMs === 60000, `${send1.resendAfterMs}ms`)

    // 冷却期内再发必须被拒，否则短信成本会被"用户狂点重发"刷掉。
    // 注意这条检查必须排在 cooldown 判断里（在 rateLimit 之前），所以不会消耗限流配额。
    let tooSoon = ''
    try {
      await cloud.sendSmsCode(PHONE, 'register')
    } catch (err) {
      tooSoon = `${err.reason}:${err.retryAfterMs ?? 'no-retryAfter'}`
    }
    check(
      '冷却期内重发被拒，且带回 retryAfterMs',
      tooSoon.startsWith('too_soon') && !tooSoon.endsWith('no-retryAfter'),
      tooSoon
    )

    const code1 = await waitForSmsCode(() => gwLog, PHONE)
    check('网关日志里能抓到验证码（证明短信通道真被调用）', /^\d{6}$/.test(code1), code1 || '(未抓到)')

    // 错误码不能放行，且要告诉用户还剩几次
    let wrongMsg = ''
    try {
      await cloud.register({ phone: PHONE, smsCode: wrongCode(code1), password: 'probe-pass-123' })
    } catch (err) {
      wrongMsg = `${err.reason} | ${err.message}`
    }
    check('验证码错误时拒绝注册', wrongMsg.startsWith('code_wrong'), wrongMsg)

    const regPhone = await cloud.register({ phone: PHONE, smsCode: code1, password: 'probe-pass-123' })
    check('手机号注册成功并拿到额度快照', Boolean(regPhone.me), regPhone.me ? regPhone.me.planName : '')
    check('手机号注册后即为已登录', cloud.cloudLoggedIn() === true)

    // 重复注册同一号码要明确报"已注册"。这条顺带验证了**查重排在验码之前**：
    // 这里故意送一个错码，报出来的仍是 phone_taken —— 用户不会被骗去重新收码。
    let taken = ''
    try {
      await cloud.register({ phone: PHONE, smsCode: '000000', password: 'probe-pass-123' })
    } catch (err) {
      taken = err.reason
    }
    check('重复注册同一手机号被拒，且先报已注册再验码', taken === 'phone_taken', taken)

    cloud.logout()

    // 登录码与注册码是不同 purpose，冷却各自独立
    const send2 = await cloud.sendSmsCode(PHONE, 'login')
    check('登录码可单独下发（冷却按 purpose 分开）', send2.resendAfterMs > 0, `${send2.resendAfterMs}ms`)
    const code2 = await waitForSmsCode(() => gwLog, PHONE)
    check('登录码与注册码不是同一个', Boolean(code2) && code2 !== code1, `${code1} → ${code2 || '(未抓到)'}`)

    const meSms = await cloud.login({ phone: PHONE, smsCode: code2 })
    check('手机验证码登录成功', Boolean(meSms), meSms ? meSms.planName : '')

    // 同一个码不能再用第二次：成功即消费
    cloud.logout()
    let reuse = ''
    try {
      await cloud.login({ phone: PHONE, smsCode: code2 })
    } catch (err) {
      reuse = err.reason
    }
    check('验证码用过即废，不能二次使用', Boolean(reuse), reuse || '(居然放行了)')

    // "账密与手机号都支持"是明确需求，三种登录组合都得能用
    cloud.logout()
    const mePwd = await cloud.login({ phone: PHONE, password: 'probe-pass-123' })
    check('手机号 + 密码也能登录', Boolean(mePwd), mePwd ? mePwd.planName : '')
    cloud.logout()
    const meAcc = await cloud.login({ account: 'probe@example.com', password: 'probe-pass-123' })
    check('账号 + 密码登录正常', Boolean(meAcc), meAcc ? meAcc.planName : '')

    // 未注册手机号：**先验码、再告知未注册**，否则这个接口就成了账号枚举通道
    cloud.logout()
    const STRANGER = '13900005678'
    await cloud.sendSmsCode(STRANGER, 'login')
    const code3 = await waitForSmsCode(() => gwLog, STRANGER)
    let stranger = ''
    try {
      await cloud.login({ phone: STRANGER, smsCode: code3 })
    } catch (err) {
      stranger = err.reason
    }
    check('未注册手机号在验码后明确提示未注册', stranger === 'phone_not_registered', stranger)

    /* ---------- 10. 未登录：所有出网入口都必须拒绝 ---------- */
    // 这一节就是"完全屏蔽自带 Key + 必须登录"在运行时的体现：
    // 没有 token 时不能有任何一条路径能发出请求。
    cloud.logout()
    check('登出后判定为未登录', cloud.cloudLoggedIn() === false)

    let asrNotLogin = ''
    try {
      cloud.asrConn()
    } catch (err) {
      asrNotLogin = err.message
    }
    check('未登录时语音落点拒绝解析', asrNotLogin.includes('登录'), asrNotLogin)

    let llmNotLogin = ''
    try {
      cloud.llmTarget({ model: 'glm-4-flash' })
    } catch (err) {
      llmNotLogin = err.message
    }
    check('未登录时大模型落点也拒绝解析（不给空 token 出网）', llmNotLogin.includes('登录'), llmNotLogin)

    let bizErr = ''
    try {
      await cloud.redeem('CMG-AAAAA-BBBBB-CCCCC')
    } catch (err) {
      bizErr = `${err.status}:${err.reason}`
    }
    check('未登录调用业务接口被网关 401 拒绝', bizErr.startsWith('401'), bizErr)
  } finally {
    try {
      gw.kill()
    } catch {
      /* noop */
    }
    try {
      mock.server.close()
    } catch {
      /* noop */
    }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.desc}${f.detail ? `  [${f.detail}]` : ''}`)
    return 1
  }
  console.log('CLOUD_OK')
  return 0
}

// watchdog：漏加过一次，挂死的探查把进程吊了 12 小时
const watchdog = setTimeout(() => {
  console.error('PROBE_TIMEOUT：90 秒未完成，强制退出')
  process.exit(1)
}, 90000)

app.whenReady().then(async () => {
  let code = 1
  try {
    code = await main()
  } catch (err) {
    console.error('探查异常终止：', err)
  } finally {
    clearTimeout(watchdog)
    app.exit(code)
  }
})
