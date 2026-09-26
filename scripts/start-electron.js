/**
 * 启动 Electron 的包装脚本。
 *
 * 为什么需要它：
 * 部分终端/宿主应用（例如基于 Electron 的 IDE、VS Code 内置终端）会往环境里注入
 *   ELECTRON_RUN_AS_NODE=1
 * 这会让 electron.exe **退化成纯 Node 进程**——主进程里 `require('electron')`
 * 返回的是可执行文件路径字符串而不是 API 对象，于是 `app.requestSingleInstanceLock()`
 * 直接抛 TypeError，窗口永远出不来，且错误一闪而过看起来像"没反应"。
 *
 * 本脚本在运行前清掉这些变量，再用干净环境启动真正的 Electron。
 * 跨平台（Windows / macOS / Linux 通用），不依赖 shell 语法。
 */
const { spawn } = require('node:child_process')
const path = require('node:path')

const POISON = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_ENABLE_LOGGING'
]

const removed = []
for (const key of POISON) {
  if (process.env[key] !== undefined) {
    removed.push(`${key}=${process.env[key]}`)
    delete process.env[key]
  }
}

// 在纯 Node 下 require('electron') 返回可执行文件路径 —— 正好就是我们要的
let electronPath
try {
  electronPath = require('electron')
} catch (err) {
  console.error('[start-electron] 找不到 Electron 可执行文件，请先执行 npm install')
  console.error(err.message)
  process.exit(1)
}

if (typeof electronPath !== 'string' || !electronPath) {
  console.error('[start-electron] 解析 Electron 路径失败')
  process.exit(1)
}

const args = process.argv.slice(2)
if (!args.length) args.push('.')

// `--dist`：让主进程加载**已构建的产物** dist/index.html，而不是 Vite dev server。
// 未打包场景下 `npm start` 靠它跑"真实产物"（否则会去连没在跑的 5173 → 白屏）。
// 这个开关只对包装脚本有意义，不能透传给 Electron。
const distFlag = args.indexOf('--dist')
if (distFlag !== -1) {
  args.splice(distFlag, 1)
  process.env.ELECTRON_LOAD_DIST = '1'
}
if (!args.length) args.push('.')

if (removed.length) {
  console.log(`[start-electron] 已清除冲突环境变量：${removed.join(', ')}`)
}

/** 快速崩溃判定窗口（毫秒）：正常启动后用户不会这么快关掉窗口 */
const CRASH_WINDOW_MS = 8000

function launch(extraArgs) {
  return new Promise((resolve) => {
    const child = spawn(electronPath, [...args, ...extraArgs], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: false
    })
    const startedAt = Date.now()
    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    child.on('error', (err) => settle({ kind: 'spawn-error', err }))
    child.on('exit', (code, signal) => {
      if (signal) {
        settle({ kind: 'killed', signal })
      } else {
        settle({
          kind: 'exit',
          code: code === null ? 0 : code,
          quick: Date.now() - startedAt < CRASH_WINDOW_MS
        })
      }
    })
  })
}

const main = async () => {
  console.log(`[start-electron] 启动 ${path.basename(electronPath)} ${args.join(' ')}`)
  let result = await launch([])

  // 启动后几秒内崩溃：最常见原因就是 GPU 进程起不来 → 软件渲染自动重试一次
  const looksLikeCrash =
    (result.kind === 'exit' && result.code !== 0 && result.quick) || result.kind === 'spawn-error'
  const alreadySw = args.includes('--sw-gl')

  if (looksLikeCrash && !alreadySw) {
    console.log(
      '[start-electron] 进程在 ' +
        CRASH_WINDOW_MS / 1000 +
        ' 秒内异常退出，疑似 GPU 环境不可用，自动切换软件渲染重试…'
    )
    result = await launch(['--sw-gl'])
  }

  if (result.kind === 'spawn-error') {
    console.error('[start-electron] 启动失败：', result.err.message)
    process.exit(1)
  }
  if (result.kind === 'killed') process.exit(1)
  process.exit(result.code)
}

void main()
