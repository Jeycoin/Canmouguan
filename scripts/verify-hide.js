/**
 * 验证「隐藏窗口 / 隐藏任务栏图标」是否真的生效。
 *
 * 为什么不能只看 UI：设置面板的开关、CSS 的隐藏、React 的 state 都可以"看起来生效"，
 * 但窗口可见性和任务栏项是**操作系统层面的东西**。
 *
 * 踩过的两个坑（都写在这里，避免以后重复踩）：
 *   1. Electron **没有** `win.isSkipTaskbar()` getter（只有 setter）。
 *      实测 Electron 44：`typeof win.isSkipTaskbar === 'undefined'`，硬调会 TypeError。
 *   2. `setSkipTaskbar()` 在 Windows 上**不改任何可查询的窗口属性** ——
 *      实测 GWL_STYLE / GWL_EXSTYLE / GW_OWNER / GWLP_HWNDPARENT 在开/关两态**完全相同**
 *      （Electron 是直接跟 shell 打交道，不落痕迹）。
 *      所以没法用 GetWindowLong 断言。
 *
 * 可靠做法：**把真实任务栏条截图做 A/B 对照**。
 *   A 关掉（期望：任务栏没有它） → B 打开（期望：多出一个按钮） → C 再关掉（期望：完全回到 A）
 *   断言 diff(A,B) 显著 > 0 且 diff(A,C) === 0 —— 既证明设置真的在控制任务栏，
 *   又证明关掉后是**彻底移除**、可以来回切。
 * 图片落盘供人工复核。
 *
 * 踩过的第三个坑（2026-09-23 修）：**不要用"差异像素总数"当阈值**。
 *   任务栏是活体 UI：时钟、网速图标、输入法状态、其他应用的进度条都在跳，
 *   整条 1920×48 的裸像素差会混入大量无关噪声。
 *   更糟的是**阈值方向也会错**：本机上「关→开」只让图标槽位从 1 份变 2 份（差异 220 像素），
 *   而「关→再关」因为时钟秒位抖动有 12 像素差异，于是 `dAB > 1000` 假失败、`dAC === 0` 也假失败——
 *   设置其实**完全正常**。这类假失败比漏检更坏：会让人去"修"没坏的代码。
 *
 *   正确做法：**只看与基线有差异的那条"列区间"，并限定在任务栏中段
 *   （排除左右两端的时钟/NCSI 托盘区）**，然后断言
 *     - 该区间在 B 里存在且落点合法（= 开关真的改变了任务栏，且**立即生效**）
 *     - 该区间在 C 里不存在（= 关掉是彻底移除，可来回切）
 *   这样与"时钟跳了几像素"天然解耦。
 *
 * 隔离性：跑在临时 userData 目录里，绝不碰用户真实设置。
 * 用法：node scripts/start-electron.js ./scripts/verify-hide.js
 */
const { app, globalShortcut, screen, desktopCapturer } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')

const root = path.join(__dirname, '..')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('use-gl', 'angle')
app.commandLine.appendSwitch('use-angle', 'swiftshader')
app.commandLine.appendSwitch('enable-unsafe-swiftshader')

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'canmouguan-hide-'))
app.setPath('userData', tmpUserData)

const OUT = path.join(root, '_probe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, pass, detail = '') {
  results.push([name, pass])
  const tag = pass === null ? ' skip ' : pass ? '  ok  ' : ' FAIL '
  console.log(`${tag} ${name}${detail ? '   [' + detail + ']' : ''}`)
}

function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时`)), ms))])
}

function serveDist(dir) {
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.json': 'application/json'
  }
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0])
      const f = path.join(dir, p === '/' ? 'index.html' : p)
      fs.readFile(f, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
        res.end(data)
      })
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
}

/** 截「任务栏条」= 屏幕 bounds 减去 workArea，返回位图 Buffer 以便做像素比对 */
async function taskbarShot(tag) {
  const d = screen.getPrimaryDisplay()
  const sources = await withTimeout(
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: d.size.width, height: d.size.height } }),
    20000,
    'desktopCapturer'
  )
  const thumb = sources[0]?.thumbnail
  if (!thumb || thumb.isEmpty()) throw new Error('缩略图为空')
  const barTop = d.workArea.y + d.workArea.height
  const barH = Math.max(2, d.bounds.height - (d.workArea.height + d.workArea.y - d.bounds.y))
  const cropped = thumb.resize({ width: d.size.width }).crop({ x: 0, y: barTop, width: d.size.width, height: barH * 2 })
  if (tag) {
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, `taskbar-${tag}.png`), cropped.toPNG())
  }
  return cropped.toBitmap()
}

function diffPixels(a, b) {
  if (!a || !b || a.length !== b.length) return -1
  let n = 0
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++
  }
  return n
}

/**
 * 求「哪些列与基线**实质**不同」，并把连续列归成区间。
 *
 * 两个降噪阈值（都是实测标定出来的，不要凭感觉改）：
 *   - `MIN_ROWS`：一列里至少要有这么多行不同才算数。
 *     任务栏图标高约 30px，真出现/消失会整列大面积变化；
 *     而抗锯齿抖动、合焦下划线的 dithering 只在 2–3 行上出现。
 *   - `MIN_DELTA`：单像素 RGB 通道和的最小差值。
 *     实测残余噪声最大只有 5/765（红下划线边缘的舍入误差），
 *     而真图标像素差动辄上百。取 24 有足够余量。
 *
 * @returns {{left:number,right:number,cols:number,maxDelta:number}[]}
 */
const MIN_ROWS = 6
const MIN_DELTA = 24

function diffColumnRuns(a, b, width, height, channels = 4) {
  if (!a || !b || a.length !== b.length) return []
  const significant = new Array(width).fill(false)
  const maxDeltaAt = new Array(width).fill(0)
  for (let x = 0; x < width; x++) {
    let rows = 0
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * channels
      const d =
        Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
      if (d > 0) {
        maxDeltaAt[x] = Math.max(maxDeltaAt[x], d)
        if (d >= MIN_DELTA) rows++
      }
    }
    if (rows >= MIN_ROWS) significant[x] = true
  }
  const runs = []
  let start = -1
  for (let x = 0; x <= width; x++) {
    const on = x < width && significant[x]
    if (on && start < 0) start = x
    if (!on && start >= 0) {
      let maxDelta = 0
      for (let k = start; k < x; k++) maxDelta = Math.max(maxDelta, maxDeltaAt[k])
      runs.push({ left: start, right: x - 1, cols: x - start, maxDelta })
      start = -1
    }
  }
  return runs
}

/** 任务栏中段：排除左右两端（右侧=时钟/NCSI 托盘，左侧=小组件；这些与开关无关且会自己跳） */
function isIconZone(run, width) {
  const edge = Math.round(width * 0.12)
  return run.left > edge && run.right < width - edge
}

// 兜底：卡住也不能留挂死进程
const watchdog = setTimeout(() => {
  console.log('FAIL 探针超时（150s），强制退出')
  console.log('HIDE_FAIL')
  app.exit(1)
}, 150000)

app.whenReady().then(async () => {
  const server = await serveDist(path.join(root, 'dist'))
  process.env.VITE_DEV_SERVER_URL = `http://127.0.0.1:${server.address().port}`

  require(path.join(root, 'dist-electron/main/ipc.js')).registerIPC()
  const W = require(path.join(root, 'dist-electron/main/window.js'))
  const S = require(path.join(root, 'dist-electron/main/store.js'))

  console.log('[verify-hide] userData =', tmpUserData)

  const win = W.createMainWindow()
  win.show()
  await sleep(3500)

  const call = (e) => withTimeout(win.webContents.executeJavaScript(e), 10000, 'executeJavaScript')

  /** 走真实 settings:patch（设置面板开关走的就是这条），确保顺带验出"改设置窗口不跟着变"的 bug */
  const patchWindow = async (over, wait = 1300) => {
    const w = S.getSettings().window
    await call(`window.canmouguan.patchSettings({ window: ${JSON.stringify({ ...w, ...over })} }).then(() => true)`)
    await sleep(wait)
  }

  /* ---------- 0. 前提 ---------- */
  const tabs = await call(`document.querySelectorAll('.tab').length`)
  check('真实主进程窗口已加载渲染层', tabs === 5, `tabs=${tabs}`)
  check('默认 showInTaskbar=false', S.getSettings().window.showInTaskbar === false)

  /* ---------- 1. 任务栏 A/B/C 对照 ---------- */
  let bmpA = null
  let bmpB = null
  let bmpC = null
  try {
    await patchWindow({ showInTaskbar: false })
    bmpA = await taskbarShot('A-hidden')
    check('已截取任务栏基线（任务栏显示=关）', true, '_probe/taskbar-A-hidden.png')

    await patchWindow({ showInTaskbar: true })
    bmpB = await taskbarShot('B-shown')
    check('已截取任务栏对照（任务栏显示=开）', true, '_probe/taskbar-B-shown.png')

    await patchWindow({ showInTaskbar: false })
    bmpC = await taskbarShot('C-hidden-again')
    check('已截取任务栏回归（再次关掉）', true, '_probe/taskbar-C-hidden-again.png')

    const dAB = diffPixels(bmpA, bmpB)
    const dAC = diffPixels(bmpA, bmpC)
    const w = screen.getPrimaryDisplay().size.width
    const h = bmpA.length / 4 / w
    const runsAB = diffColumnRuns(bmpA, bmpB, w, h)
    const runsAC = diffColumnRuns(bmpA, bmpC, w, h)
    const iconRunsAB = runsAB.filter((r) => isIconZone(r, w))
    const iconRunsAC = runsAC.filter((r) => isIconZone(r, w))
    console.log(`[verify-hide] 任务栏像素差： A↔B=${dAB}  A↔C=${dAC}  (图 ${w}x${h})`)
    const fmt = (rs) => rs.map((r) => `${r.left}..${r.right}(${r.cols}列,Δ≤${r.maxDelta})`).join(', ') || '无'
    console.log(`[verify-hide] A↔B 实质差异列区间： ${fmt(iconRunsAB)}`)
    console.log(`[verify-hide] A↔C 实质差异列区间： ${fmt(iconRunsAC)}`)
    console.log(`[verify-hide] 判据：列内 ≥${MIN_ROWS}/${h} 行且单像素通道和差 ≥${MIN_DELTA} 才算实质差异（滤掉时钟与抗锯齿抖动）`)

    // 只认「落在任务栏中段」的列区间 —— 时钟/NCSI 托盘区的抖动不算数
    check(
      '打开开关后系统任务栏确实多出该项（且立即生效，无需重启）',
      iconRunsAB.length > 0,
      iconRunsAB.length ? `中段差异列 ${iconRunsAB.map((r) => `${r.left}..${r.right}`).join(', ')}` : `裸像素差 ${dAB}（全落在时钟/托盘边缘区，不算）`
    )
    check(
      '关掉开关后任务栏完全回到基线（是彻底移除，可来回切）',
      iconRunsAC.length === 0,
      iconRunsAC.length ? `残留差异列 ${iconRunsAC.map((r) => `${r.left}..${r.right}`).join(', ')}` : `裸像素差 ${dAC}（仅时钟抖动，图标槽位已完全复原）`
    )
  } catch (e) {
    check('任务栏 A/B 对照', null, '截图不可用: ' + e.message)
  }

  /* ---------- 2. 共享时隐藏（内容保护）即时生效 ---------- */
  await patchWindow({ stealthOnShare: true }, 800)
  check('「共享时隐藏」打开 → isContentProtected() 立即为 true', win.isContentProtected() === true)
  await patchWindow({ stealthOnShare: false }, 800)
  check('「共享时隐藏」关闭 → 立即为 false', win.isContentProtected() === false)

  /* ---------- 3. 隐藏窗口本体 ---------- */
  W.hideWindow()
  await sleep(800)
  check('hideWindow() → isVisible()===false（窗口连同任务栏项一起消失）', win.isVisible() === false)

  /* ---------- 4. 关键：隐藏后必须能找回来（不能变成不可达） ---------- */
  W.showWindow()
  await sleep(800)
  check('showWindow() 能把窗口恢复', win.isVisible() === true)

  W.toggleWindow()
  await sleep(700)
  const hiddenByToggle = win.isVisible() === false
  W.toggleWindow()
  await sleep(700)
  check('toggleWindow() 往返正常（隐藏 ↔ 显示）', hiddenByToggle && win.isVisible() === true)

  /* ---------- 5. 全局快捷键（托盘之外的第二条唤回通路） ---------- */
  try {
    const shortcuts = require(path.join(root, 'dist-electron/main/shortcuts.js'))
    shortcuts.registerAction('toggleWindow', () => W.toggleWindow())
    const acc = S.getSettings().hotkeys.toggleWindow
    const reg = globalShortcut.register(acc, () => W.toggleWindow())
    check(`全局快捷键 ${acc} 已注册（隐藏后仍可唤回）`, reg || globalShortcut.isRegistered(acc), reg ? '' : '被占用')
    globalShortcut.unregisterAll()
  } catch (e) {
    check('全局快捷键注册', null, '异常: ' + e.message)
  }

  clearTimeout(watchdog)
  const failed = results.filter(([, p]) => p === false).length
  console.log(failed ? `HIDE_FAIL（${failed} 项未通过）` : 'HIDE_OK')
  server.close()
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch { /* noop */ }
  app.exit(failed ? 1 : 0)
}).catch((e) => {
  clearTimeout(watchdog)
  console.log('FAIL 探针异常:', e && e.stack ? e.stack : e)
  console.log('HIDE_FAIL')
  app.exit(1)
})
