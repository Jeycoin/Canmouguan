/**
 * 验证「已构建产物的 GPU 自愈」：坏 GPU 环境下第一次崩溃，第二次自动改用软件渲染。
 *
 * 背景：`scripts/start-electron.js` 早就有"启动即崩 → 带 --sw-gl 重试"的兜底，
 * 但那只覆盖**开发入口**。打包后的 exe 是用户双击直接跑的，没有任何包装脚本，
 * 于是坏 GPU 环境（虚拟机 / 远程桌面 / 显卡驱动异常）下用户看到的是"双击没反应"。
 * 主进程里因此加了崩溃标记自愈机制（见 electron/main/index.ts）。
 *
 * 做法：同一个临时 userData 连跑两次真实 main（**不带** --sw-gl）：
 *   第一次：期望 GPU FATAL 崩溃，且崩溃标记文件留下
 *   第二次：同一 userData → 期望日志出现「自动改用软件渲染」并成功启动
 * 两次都设 ELECTRON_LOAD_DIST=1，加载真实 dist 产物，而不是依赖外部是否恰好有 dev server。
 *
 * 在**有可用 GPU** 的机器上第一次不会崩，此时整体报 SKIP（这个行为只对坏 GPU 环境有意义）。
 *
 * 用法：npm run verify:gpu
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const root = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(userData, extraArgs, waitMs) {
  const electronBin = require('electron')
  const child = spawn(electronBin, ['.', ...extraArgs], {
    cwd: root,
    env: (() => {
      const e = { ...process.env }
      delete e.ELECTRON_RUN_AS_NODE
      e.CANMOUGUAN_USER_DATA = userData
      e.ELECTRON_LOAD_DIST = '1'
      delete e.VITE_DEV_SERVER_URL
      return e
    })(),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d.toString()))
  child.stderr.on('data', (d) => (out += d.toString()))
  return new Promise((resolve) => {
    let done = false
    const finish = (code, signal) => {
      if (done) return
      done = true
      resolve({ code, signal, out, alive: false })
    }
    child.on('exit', finish)
    setTimeout(() => {
      if (done) return
      done = true
      // 还活着 = 启动成功
      try { child.kill() } catch { /* noop */ }
      resolve({ code: null, signal: null, out, alive: true })
    }, waitMs)
  })
}

;(async () => {
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
    console.log('FAIL 未找到 dist/index.html —— 请先执行 npm run build')
    process.exit(1)
  }

  // 全局看门狗（挂死时强制退出，别重演"探针挂 12 小时"）
  setTimeout(() => {
    console.log('FAIL 看门狗超时（180s），强制退出')
    process.exit(1)
  }, 180000)

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'canmouguan-gpu-'))
  const marker = path.join(userData, 'gpu-crash-marker')
  console.log('[gpu-verify] userData =', userData)

  /* ---- 第一次：不带 --sw-gl，模拟打包版用户双击 ---- */
  console.log('\n===== 第一次启动（硬件渲染，坏 GPU 环境应崩溃）=====')
  const r1 = await run(userData, [], 12000)
  console.log(`退出: alive=${r1.alive} code=${r1.code} signal=${r1.signal}`)
  const crashed = !r1.alive
  console.log('日志关键行:', r1.out.split('\n').filter((l) => /GPU process isn't usable|FATAL|软件渲染/.test(l)).slice(0, 3).join(' | ') || '(无)')

  if (!crashed) {
    console.log('\nSKIP 本机 GPU 可用，第一次没有崩溃 —— 该自愈路径无法在此环境验证')
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* noop */ }
    process.exit(0)
  }

  const markerLeft = fs.existsSync(marker)
  console.log('崩溃标记是否留下:', markerLeft)

  /* ---- 第二次：同一 userData，应自动切软件渲染 ---- */
  console.log('\n===== 第二次启动（同一数据目录，应自动自愈）=====')
  const r2 = await run(userData, [], 14000)
  const healed = r2.out.includes('自动改用软件渲染')
  console.log(`退出: alive=${r2.alive} code=${r2.code} signal=${r2.signal}`)
  console.log('自愈日志:', healed ? '已出现「自动改用软件渲染」' : '未出现')
  const markerCleared = !r2.alive || !fs.existsSync(marker)
  console.log('启动成功后标记是否被清掉:', markerCleared)

  const results = [
    ['第一次在坏 GPU 环境下崩溃（复现真实场景）', crashed],
    ['崩溃后留下启动标记', markerLeft],
    ['第二次自动启用软件渲染并成功启动', healed && r2.alive],
    ['启动成功后清除标记（下次会先试硬件渲染，不会永久降级）', markerCleared]
  ]
  let failed = 0
  console.log('')
  for (const [name, ok] of results) {
    if (!ok) failed++
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`)
  }
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* noop */ }
  console.log(failed ? `GPU_FAIL（${failed} 项未通过）` : 'GPU_OK')
  process.exit(failed ? 1 : 0)
})()
