/**
 * 打包产物端到端校验。
 *
 * 为什么需要它：`npm run smoke` 是把 dist/ 用本地 HTTP 服务喂给 electron 跑的，
 * 走的是 http://127.0.0.1 —— 和打包后 `loadFile()` 出来的 file:///…/app.asar/… 是**两条完全不同的加载路径**。
 * 绝对路径资源、ES module 的 CORS、CSP 'self' 在 file:// 下的行为都可能只在打包产物里炸。
 * 所以打完之后必须单独验一次真产物。
 *
 * 用法：node scripts/verify-packaged.js [exe路径]
 * 默认找 release/win-unpacked/参谋官.exe
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')

const PORT = 9223
const root = path.join(__dirname, '..')

function findExe() {
  if (process.argv[2]) return process.argv[2]
  const dir = path.join(root, 'release', 'win-unpacked')
  if (!fs.existsSync(dir)) return null
  const exe = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.exe'))
  return exe ? path.join(dir, exe) : null
}

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

/** 极简 CDP 客户端：只用 ws 发一两条 Runtime.evaluate，不引 puppeteer */
async function cdpEvaluate(wsUrl, expression) {
  const WebSocket = require('ws')
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      try { ws.terminate() } catch { /* noop */ }
      reject(new Error('CDP 超时'))
    }, 8000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    })
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)))
      if (msg.result?.exceptionDetails) return reject(new Error(msg.result.exceptionDetails.text))
      resolve(msg.result?.result?.value)
    })
    ws.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const exe = findExe()
  if (!exe || !fs.existsSync(exe)) {
    console.log('FAIL 找不到打包产物 exe，请先跑 npm run dist:dir')
    process.exit(1)
  }
  console.log('[verify] exe =', exe)

  /**
   * 把软件渲染旗标**转发给被 spawn 的 exe**。
   *
   * 踩过的坑：本脚本只 spawn 了 `--remote-debugging-port`，所以
   * `node scripts/start-electron.js ./scripts/verify-packaged.js <exe>` 里的 `--sw-gl`
   * 只作用在**本脚本自己的进程**上，根本没有传给 exe ——
   * 于是坏 GPU 环境下 `verify:packaged` 永远跑不起来，哪怕应用自身的自愈逻辑是对的。
   *
   * 通过环境变量 `VERIFY_SW_GL=1` 显式传递（比解析 argv 更明确，也不受 `--` 转发规则影响）。
   */
  const extraArgs = []
  if (process.env.VERIFY_SW_GL === '1' || process.argv.includes('--sw-gl')) {
    extraArgs.push('--sw-gl')
    console.log('[verify] 追加软件渲染旗标 --sw-gl（给 exe，不是给本脚本）')
  }

  const child = spawn(exe, [`--remote-debugging-port=${PORT}`, ...extraArgs], {
    // 打包产物必须清掉这个变量，否则 electron.exe 会退化成纯 Node 进程
    env: (() => { const e = { ...process.env }; delete e.ELECTRON_RUN_AS_NODE; return e })(),
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const logs = []
  child.stdout.on('data', (d) => logs.push('[out] ' + d.toString().trim()))
  child.stderr.on('data', (d) => logs.push('[err] ' + d.toString().trim()))

  // asar 内的文件清单（用于确认 worklet 等静态资源真的进了包）
  let asarFiles = []
  const asarPath = path.join(path.dirname(exe), 'resources', 'app.asar')
  if (fs.existsSync(asarPath)) {
    try {
      const asar = require('@electron/asar')
      asarFiles = asar.listPackage(asarPath).map((f) => f.replace(/\\/g, '/'))
    } catch (e) {
      logs.push('[verify] 读取 asar 失败: ' + e.message)
    }
  } else {
    // portable 版没有外置 resources/，属正常形态
    logs.push('[verify] 该产物无外置 app.asar（portable），跳过 asar 清单检查')
  }

  let target = null
  for (let i = 0; i < 30 && !target; i++) {
    await sleep(1000)
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch { /* 还没起来 */ }
  }

  let ok = false
  if (!target) {
    console.log('FAIL 30 秒内没有拿到渲染进程 target —— 窗口没起来或页面没加载')
  } else {
    console.log('[verify] page url =', target.url)
    console.log('[verify] page title =', target.title)

    /*
     * portable 版是自解压的：先把 ~110MB 解到 %TEMP%\<随机名> 再启动，
     * target 出现时页面往往还在解析，此刻 evaluate 会直接抛 Uncaught。
     * 所以必须轮询到「React 真的挂载了」为止，不能拿到 target 就断言。
     */
    const expr = `(() => ({
       href: location.href,
       protocol: location.protocol,
       readyState: document.readyState,
       appMounted: document.querySelectorAll('.app').length,
       paneCount: document.querySelectorAll('.pane').length,
       tabCount: document.querySelectorAll('.tab').length,
       titleText: document.querySelector('.titlebar .title')?.textContent || null,
       bridge: typeof window.canmouguan,
       bgAlpha: getComputedStyle(document.documentElement).getPropertyValue('--bg-alpha').trim(),
       workletUrl: new URL('recorder-worklet.js', document.baseURI).href,
       bodyText: (document.body.innerText || '').slice(0, 60)
     }))()`

    let probe = null
    for (let i = 0; i < 20; i++) {
      try {
        probe = await cdpEvaluate(target.webSocketDebuggerUrl, expr)
        if (probe && probe.appMounted >= 1) break
      } catch (e) {
        logs.push(`[verify] 第 ${i + 1} 次探测未就绪: ${e.message}`)
      }
      await sleep(1500)
    }

    if (!probe) {
      console.log('FAIL 页面始终无法求值（未就绪）')
    } else {
      console.log('[verify] DOM =', JSON.stringify(probe, null, 2))

      // portable 版把 app.asar 封在 exe 里自解压到 %TEMP%，旁边没有 resources/ 目录，
      // 这种形态下 asar 清单读不到 —— 记为「跳过」，由下面的 worklet URL 断言兜底。
      const workletInAsar = asarFiles.length === 0 ? null : asarFiles.some((f) => f.endsWith('/dist/recorder-worklet.js'))
      const checks = [
        ['渲染层走的是 file:// 协议', probe.protocol === 'file:'],
        ['产物在 asar 内', String(probe.href).includes('app.asar')],
        ['React 已挂载（.app 存在）', probe.appMounted >= 1],
        ['五个面板常驻挂载', probe.paneCount === 5],
        ['IPC 桥注入成功', probe.bridge === 'object'],
        ['标题栏品牌 = 参谋官', probe.titleText === '参谋官'],
        ['--bg-alpha 已由设置写入', Number(probe.bgAlpha) > 0],
        ['worklet 在 asar 内', workletInAsar],
        [
          // 绝对路径 '/recorder-worklet.js' 在 file:// 下会解析到磁盘根目录，录音会直接不可用
          'worklet URL 与 index.html 同级（非磁盘根）',
          String(probe.workletUrl).includes('app.asar/dist/recorder-worklet.js')
        ]
      ]
      for (const [name, pass] of checks) {
        const tag = pass === null ? ' skip ' : pass ? '  ok  ' : ' FAIL '
        console.log(`${tag} ${name}`)
      }
      ok = checks.every(([, p]) => p !== false)
    }
  }

  try { child.kill() } catch { /* noop */ }
  await sleep(600)
  if (logs.length) console.log('[verify] 进程输出:\n' + logs.join('\n'))
  console.log(ok ? 'PACKAGED_OK' : 'PACKAGED_FAIL')
  process.exit(ok ? 0 : 1)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
