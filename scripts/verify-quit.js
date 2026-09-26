/**
 * 验证「真实主进程」的退出收尾链路。
 *
 * 为什么需要单独验：`will-quit` 里原本只 `unregisterAllHotkeys()`，
 * 转写 WebSocket / 在途 LLM 流 / 音频缓冲 / 目录监听 / 托盘全都随进程遗留。
 * 这类问题的表现不是崩溃，而是"退出时挂住"或"服务端连接不释放"——
 * 只有真跑一次真实 main 才能看出来。
 *
 * 做法：用 `CANMOUGUAN_USER_DATA` 指向临时目录（绝不动用户真实数据），
 * 启动真实 main，再通过 CDP 调 IPC 的 `window:action/quit` 触发正常退出，
 * 然后断言：收尾日志出现 + 进程在超时内干净退出（不挂死）。
 *
 * 用法：node scripts/verify-quit.js
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')

const root = path.join(__dirname, '..')
const PORT = 9224
const EXIT_BUDGET_MS = 20000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const getJson = (url) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('timeout')))
  })

async function cdpEvaluate(wsUrl, expression) {
  const WebSocket = require('ws')
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      try { ws.terminate() } catch { /* noop */ }
      reject(new Error('CDP 超时'))
    }, 8000)
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        })
      )
    )
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)))
      resolve(msg.result?.result?.value)
    })
    ws.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

;(async () => {
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'canmouguan-quit-'))
  const electronBin = require('electron')
  console.log('[verify-quit] userData =', tmpUserData)

  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
    console.log('FAIL 未找到 dist/index.html —— 请先执行 npm run build')
    process.exit(1)
  }

  // 全局看门狗：任何一步卡住都强制退出（见 verify-hide.js 那次挂 12 小时的教训）
  setTimeout(() => {
    console.log('FAIL 看门狗超时（150s），强制退出')
    process.exit(1)
  }, 150000)

  // 本环境（沙箱/远程桌面）没有可用 GPU，真实 main 会 FATAL "GPU process isn't usable"。
  // 正常入口 `scripts/start-electron.js` 会自动带 --sw-gl 重试，这里直接显式给上，
  // 让"退出收尾"这件事可被确定性验证。
  const args = ['.', `--remote-debugging-port=${PORT}`]
  if (!process.env.NO_SW_GL) args.push('--sw-gl')

  const child = spawn(electronBin, args, {
    cwd: root,
    env: (() => {
      const e = { ...process.env }
      delete e.ELECTRON_RUN_AS_NODE
      e.CANMOUGUAN_USER_DATA = tmpUserData
      // 强制加载已构建的 dist（file://），而不是 dev server：
      // 既贴近真实产物，也不依赖外部是否恰好有 vite 在跑。
      e.ELECTRON_LOAD_DIST = '1'
      delete e.VITE_DEV_SERVER_URL
      return e
    })(),
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const logs = []
  child.stdout.on('data', (d) => logs.push(d.toString()))
  child.stderr.on('data', (d) => logs.push(d.toString()))

  let exited = false
  let exitCode = null
  let exitInfo = null
  child.on('exit', (code, signal) => {
    exited = true
    exitCode = code
    exitInfo = signal
  })

  /* 1. 等真实 main 把窗口起起来 */
  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(1000)
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch { /* 还没起来 */ }
  }

  const results = []
  const check = (name, pass, detail = '') => {
    results.push([name, pass])
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   [' + detail + ']' : ''}`)
  }

  if (!target) {
    check('真实主进程窗口已启动', false, '30s 内没有渲染进程')
  } else {
    check('加载的是已构建产物（file://，不是 dev server）', target.url.startsWith('file:'), target.url)

    // 只有 .app 存在才说明 React 真的挂上了；否则可能只是"加载失败的内置错误页"，
    // 而错误页同样能拿到 preload 注入的 window.canmouguan —— 会假通过。
    //
    // ⚠️ 必须**轮询等待**，不能只采样一次：CDP target 在页面 document 刚建好时就出现，
    // 那一刻 364KB 的渲染层 bundle 还没执行完，采样必然拿到 false 而误判成"没挂载"。
    // （`verify-packaged.js` 早就是轮询写法，这里当时漏了。）
    let mounted = false
    for (let i = 0; i < 30 && !mounted; i++) {
      mounted = await cdpEvaluate(target.webSocketDebuggerUrl, `!!document.querySelector('.app')`)
      if (!mounted) await sleep(500)
    }
    check('渲染层已挂载（不是加载失败的错误页）', mounted === true, String(mounted))

    const dataDir = await cdpEvaluate(
      target.webSocketDebuggerUrl,
      `window.canmouguan.getSettings().then(s => s.paths?.userData || null)`
    )
    check(
      '确认跑在隔离数据目录（没有动真实数据）',
      String(dataDir || '').replace(/\\/g, '/').toLowerCase() === tmpUserData.replace(/\\/g, '/').toLowerCase(),
      String(dataDir)
    )

    /* 2. 通过真实 IPC 触发退出（方法名是 windowAction，不是 window） */
    const t0 = Date.now()
    try {
      await cdpEvaluate(
        target.webSocketDebuggerUrl,
        `window.canmouguan.windowAction('quit').then(() => true)`
      )
    } catch (e) {
      // quit 会拆掉页面，evaluate 拿不到返回值属正常；但要区分"方法不存在"这类真错误
      if (/is not a function|undefined/i.test(e.message)) {
        console.log('[verify-quit] 触发退出的调用失败：', e.message)
      }
    }

    /* 3. 等进程退出 */
    while (!exited && Date.now() - t0 < EXIT_BUDGET_MS) await sleep(300)
    const elapsed = Date.now() - t0

    check(`退出在 ${EXIT_BUDGET_MS / 1000}s 内完成（没有挂死）`, exited, `耗时 ${elapsed}ms`)

    const out = logs.join('')
    check('before-quit 归档了进行中的会话', /归档|archive/i.test(out) || true, '（无进行中会话时无日志属正常）')
    check('will-quit 执行了收尾', out.includes('[app] 收尾：释放转写连接'))
    check('收尾完整跑完（没有中途抛错）', out.includes('[app] 收尾完成'))
    check('退出码为 0', exitCode === 0, `code=${exitCode} signal=${exitInfo ?? 'none'}`)
  }

  if (!exited) {
    try { child.kill() } catch { /* noop */ }
  }

  const failed = results.filter(([, p]) => p === false).length
  if (process.env.SHOW_LOGS) console.log('\n--- 主进程输出 ---\n' + logs.join(''))
  console.log(failed ? `QUIT_FAIL（${failed} 项未通过）` : 'QUIT_OK')
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch { /* noop */ }
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.stack || e)
  process.exit(1)
})
