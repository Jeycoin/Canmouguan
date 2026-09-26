import { app, BrowserWindow, Menu, Tray, nativeImage, session, screen, desktopCapturer, shell } from 'electron'
import zlib from 'node:zlib'
import path from 'node:path'
import fs from 'node:fs'
import { createMainWindow, getMainWindow, windowEvents, showWindow, toggleWindow, hideWindow, toggleClickThrough, toggleAlwaysOnTop, applyClickThrough, setOpacity } from './window'
import { registerIPC, broadcast, disposeRuntime } from './ipc'
import { registerAction, registerAllHotkeys, unregisterAllHotkeys } from './shortcuts'
import { getSettings, loadSettings, getDefaultKnowledgeDir, getUserDataDir } from './store'
import { loadKnowledge, watchKnowledge, closeKnowledgeWatcher, knowledgeEvents } from './knowledge'
import { memoryEvents, applyRetention, archiveCurrentSession, restoreCurrentSession } from './memory'
import { pinUserDataDir } from './appdir'

/* ------------------------------ 环境自检 ------------------------------ */

/**
 * 若被 ELECTRON_RUN_AS_NODE=1 影响，electron 会以纯 Node 模式运行，
 * require('electron') 返回的是路径字符串而不是 API。这里给出明确提示，
 * 避免"窗口没出来但也没报错"这种最难排查的情况。
 */
if (typeof (app as unknown as { requestSingleInstanceLock?: unknown })?.requestSingleInstanceLock !== 'function') {
  console.error(
    '\n[参谋官] 启动失败：Electron 正以纯 Node 模式运行。\n' +
      '原因：环境变量 ELECTRON_RUN_AS_NODE 被设置（常见于某些 IDE 的内置终端）。\n' +
      '解决：用 npm run dev 或 npm start 启动（包装脚本会自动清掉该变量），\n' +
      '      或手动执行 unset ELECTRON_RUN_AS_NODE（PowerShell: $env:ELECTRON_RUN_AS_NODE=""）。\n'
  )
  process.exit(1)
}

/* --------------------------- 数据目录（务必最先执行） --------------------------- */

// 见 appdir.ts：把 userData 钉到固定 ASCII 目录并搬迁旧数据。
// 必须在 requestSingleInstanceLock 之前 —— 单实例锁文件就写在 userData 里。
pinUserDataDir()

/* ------------------------------ 单实例锁 ------------------------------ */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showWindow()
  })
}

/* ------------------------------ 托盘图标 ------------------------------ */

/** 运行时生成一张 32×32 PNG，避免额外二进制资源 */
function makeTrayIcon(): Electron.NativeImage {
  const size = 32
  const raw = Buffer.alloc((size * 4 + 1) * size)
  const cx = size / 2
  const cy = size / 2
  let p = 0
  for (let y = 0; y < size; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const dx = x - cx + 0.5
      const dy = y - cy + 0.5
      const dist = Math.sqrt(dx * dx + dy * dy)
      // 圆角矩形底
      const inRound = dist <= size / 2 - 1
      // 中间白色"麦克风点"
      const inDot = dist <= size / 5
      if (!inRound) {
        raw[p++] = 0
        raw[p++] = 0
        raw[p++] = 0
        raw[p++] = 0
      } else if (inDot) {
        raw[p++] = 255
        raw[p++] = 255
        raw[p++] = 255
        raw[p++] = 255
      } else {
        raw[p++] = 24
        raw[p++] = 110
        raw[p++] = 245
        raw[p++] = 255
      }
    }
  }
  const png = buildPng(size, size, raw)
  return nativeImage.createFromBuffer(png)
}

function buildPng(width: number, height: number, rawScanlines: Buffer): Buffer {
  const chunks: Buffer[] = []
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  chunks.push(sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rawScanlines)), chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

let crcTable: Uint32Array | null = null
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ 0xffffffff
}

/* ------------------------------ 权限与媒体 ------------------------------ */

function setupPermissions() {
  const ses = session.defaultSession

  /**
   * 「是不是自己人」用 **webContents 身份**判定，不用来源字符串。
   *
   * 为什么不能用 isOwnOrigin：`setPermissionCheckHandler` 的第 3 个参数 `requestingOrigin`
   * 是**裸 origin**。打包环境下 file:// 页面的 origin 就是字符串 "file://"，
   * 拿它跟 dist/index.html 的完整路径比永远不会相等 → 会把自家录音权限一起拒掉，
   * 表现为"打包后麦克风没声"，而且很难查。webContents 身份是精确、无法伪造的。
   *
   * wc 为 null 时放行：Electron 在部分检查里会传 null，且真正的入口控制
   * 是 window.ts 里收紧后的 isOwnOrigin（外来页面根本进不来这个 webContents）。
   */
  const isSelfContents = (wc: Electron.WebContents | null | undefined) =>
    !wc || wc === getMainWindow()?.webContents

  /**
   * 权限请求处理：只放行媒体（麦克风/屏幕），并记录审计日志。
   * 注意：这里 callback 必须同步响应，无法等待 UI 弹窗。
   */
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const allowed = permission === 'media' && isSelfContents(wc)
    if (allowed) {
      console.log('[permission] 已放行媒体权限请求', details?.requestingUrl ?? '(未知来源)')
    } else {
      console.warn('[permission] 已拒绝权限请求', permission, details?.requestingUrl ?? '(未知来源)')
    }
    callback(allowed)
  })
  ses.setPermissionCheckHandler((wc, permission) => permission === 'media' && isSelfContents(wc))

  /**
   * getDisplayMedia：自动选择当前鼠标所在屏幕 + loopback 音频。
   * 这是为了捕获会议软件声音，属于本工具核心功能；但仍记录审计日志。
   * 后续可在设置中增加显式开关让用户选择是否启用 loopback。
   */
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      // 同样用帧身份判定。只有能明确断定"不是主窗口那一帧"时才拒绝；
      // frame 为 null（已导航/已销毁）时按放行处理，避免误伤自家采集链路。
      const ownFrame = getMainWindow()?.webContents.mainFrame
      if (request?.frame && ownFrame && request.frame !== ownFrame) {
        console.warn('[display-media] 拒绝非主窗口帧的屏幕捕获请求', request.securityOrigin)
        callback({})
        return
      }
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 64, height: 64 }
      })
      const point = screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(point)
      const preferred =
        sources.find((src) => src.display_id === String(display.id)) ??
        sources.find((src) => src.id.includes(String(display.id))) ??
        sources[0]
      if (!preferred) {
        callback({})
        return
      }
      console.log('[display-media] 返回屏幕源', preferred.id, 'audio=loopback')
      callback({ video: preferred, audio: 'loopback' })
    } catch (err) {
      console.error('[display-media] 获取屏幕源失败', err)
      callback({})
    }
  })
}

/* ------------------------------ 快捷键接线 ------------------------------ */

function wireHotkeys() {
  registerAction('toggleWindow', () => {
    toggleWindow()
  })
  registerAction('toggleClickThrough', () => {
    const on = toggleClickThrough()
    broadcast('toast', { text: on ? '鼠标穿透：开（点击将穿过窗口）' : '鼠标穿透：关（可交互）' })
  })
  registerAction('toggleAlwaysOnTop', () => {
    const on = toggleAlwaysOnTop()
    broadcast('toast', { text: on ? '已置顶' : '已取消置顶' })
  })
  registerAction('toggleRecording', () => broadcast('hotkey:toggleRecording', {}))
  registerAction('screenshot', () => broadcast('hotkey:screenshot', {}))
  registerAction('panicHide', () => {
    hideWindow(true)
    applyClickThrough(true)
    broadcast('hotkey:panicHide', {})
    broadcast('toast', { text: '已紧急隐藏' })
  })
  registerAction('panicMute', () => {
    broadcast('hotkey:panicMute', {})
    broadcast('toast', { text: '已紧急静音' })
  })
}

/* ------------------------------ 应用菜单 ------------------------------ */

/**
 * frameless 窗口本身不显示菜单栏，所以这份菜单不是为了看，而是为了**注册快捷键**。
 *
 * Windows / Linux 上 Electron 默认没有应用菜单，而 Chromium 的标准编辑命令
 * （Ctrl+C / Ctrl+V / Ctrl+A …）只有在菜单项带对应 role 时才会被注册。
 * 缺了它，用户在输入框里粘贴不了 JD 和题目 —— 这是本工具最直接的输入方式。
 */
function setupEditMenu() {
  const isMac = process.platform === 'darwin'
  const editMenu: Electron.MenuItemConstructorOptions = {
    label: '编辑',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'delete' },
      { type: 'separator' },
      { role: 'selectAll' }
    ]
  }
  // macOS 的菜单必须保留 App 组，否则连带"关于/隐藏/退出"一起没了
  const template: Electron.MenuItemConstructorOptions[] = isMac ? [{ role: 'appMenu' }, editMenu] : [editMenu]
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  } catch (err) {
    console.error('[menu] 注册编辑菜单失败', err)
  }
}

/* ------------------------------ 托盘菜单 ------------------------------ */

let tray: Tray | null = null

function setupTray() {
  tray = new Tray(makeTrayIcon())
  tray.setToolTip('参谋官')
  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: () => toggleWindow() },
    { label: '鼠标穿透 / 可交互', click: () => toggleClickThrough() },
    { label: '始终置顶', click: () => toggleAlwaysOnTop() },
    { type: 'separator' },
    { label: '背景不透明度 100%（全实）', click: () => setOpacity(1) },
    { label: '背景不透明度 92%（默认）', click: () => setOpacity(0.92) },
    { label: '背景不透明度 80%', click: () => setOpacity(0.8) },
    { label: '背景不透明度 65%', click: () => setOpacity(0.65) },
    { type: 'separator' },
    { label: '打开知识库目录', click: () => void shell.openPath(getSettings().knowledgeDir || getDefaultKnowledgeDir()) },
    { label: '打开数据目录', click: () => void shell.openPath(getUserDataDir()) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => toggleWindow())
}

/* ------------------------------ 生命周期 ------------------------------ */

/* ------------------------------ GPU 软件渲染降级 ------------------------------ */

/**
 * 某些环境（远程桌面、驱动异常、无 GPU 会话）下 Electron 的 GPU 进程根本起不来，
 * 直接 FATAL "GPU process isn't usable"，窗口都来不及创建。
 *
 * 开发时 `scripts/start-electron.js` 会检测"启动后几秒内崩溃"并自动带 --sw-gl 重试；
 * 也可以手动 `npm run dev:sw` 进入软件渲染模式。
 * 软件渲染下毛玻璃依然可用（CPU 绘制），只是帧率略低。
 *
 * **但打包后的 exe 没有那个包装脚本** —— 用户双击启动，撞上坏 GPU 就是"闪一下就没了"，
 * 连错误都看不到。所以这里补一套自愈机制（见文件末尾 markStartupOk）：
 *   上次启动没能走到"加载完成" → 这次直接按软件渲染启动。
 * 成功加载后清掉标记，于是下次又会先试硬件渲染，不会永久降级。
 */
const GPU_CRASH_MARKER = () => path.join(getUserDataDir(), 'gpu-crash-marker')

/** 上次启动是否在"窗口加载完成"之前就死了（标记还留着） */
function lastStartCrashed(): boolean {
  try {
    return fs.existsSync(GPU_CRASH_MARKER())
  } catch {
    return false
  }
}

/** 记下"本次启动进行中"；只有走到加载完成才会被清掉 */
function markStartupPending(): void {
  try {
    fs.mkdirSync(path.dirname(GPU_CRASH_MARKER()), { recursive: true })
    fs.writeFileSync(GPU_CRASH_MARKER(), String(Date.now()), 'utf8')
  } catch (err) {
    console.error('[gpu] 写入启动标记失败', err)
  }
}

/** 标记启动成功，清除崩溃标记 */
export function markStartupOk(): void {
  try {
    if (fs.existsSync(GPU_CRASH_MARKER())) fs.unlinkSync(GPU_CRASH_MARKER())
  } catch (err) {
    console.error('[gpu] 清除启动标记失败', err)
  }
}

const forceSoftware = process.argv.includes('--sw-gl')
const recoveredFromCrash = lastStartCrashed()

/**
 * 需要走软件渲染时，**必须重新拉起自己**，把旗标放到命令行上。
 *
 * ⚠️ 这里是踩过坑之后改的，别退回到 `appendSwitch` 的写法。
 *
 * 原来的写法是在模块顶层调 `app.commandLine.appendSwitch('disable-gpu')`，
 * 结果**完全无效**：坏 GPU 环境下照样 FATAL `GPU process isn't usable. Goodbye.`，
 * 日志里连自愈那行都没打印出来 —— 因为 Chromium 的 GPU 进程初始化
 * 与主进程 JS 模块求值是**并发**的，GPU 进程在这行 JS 执行前就已经拉起并崩了。
 *
 * 实测对比（同一个 exe、同一个坏 GPU 环境）：
 *   - 命令行传 `--disable-gpu`        → ✅ 正常启动，不 FATAL
 *   - 只在 JS 里 `appendSwitch(...)`  → ❌ 照样 FATAL
 *   两者的唯一差别就是"旗标在 Chromium 启动前是否已存在"。
 *
 * 所以自愈分两步：
 *   1. **第一次**启动（有崩溃标记 / 带 --sw-gl）：进程刚起来时还不知道要不要降级，
 *      此时**重新 spawn 一个自己**，把旗标写进 argv，然后立刻退出当前进程。
 *   2. 子进程带着 `--sw-gl` 正常走完（此时 `forceSoftware === true`，第 2 步条件已满足，不会无限重启）。
 *
 * 用 `CANMOUGUAN_SW_RELAUNCH=1` 做重入保护：子进程带了它就不再重拉，避免万一旗标丢失导致 fork 炸弹。
 */
const SW_RELAUNCH_FLAG = 'CANMOUGUAN_SW_RELAUNCH'
const needsRelaunch =
  (forceSoftware || recoveredFromCrash) && process.env[SW_RELAUNCH_FLAG] !== '1'

if (needsRelaunch && app.isPackaged) {
  try {
    console.log(
      forceSoftware
        ? '[gpu] 以软件渲染重新拉起进程（旗标必须在命令行上，appendSwitch 太晚）'
        : '[gpu] 检测到上次启动未能加载完成，改用软件渲染重新拉起进程'
    )
    const { spawn } = require('node:child_process') as typeof import('node:child_process')
    const argv = process.argv.slice(1).filter((a) => a !== '--sw-gl')
    const child = spawn(process.execPath, [...argv, '--sw-gl'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, [SW_RELAUNCH_FLAG]: '1' }
    })
    child.unref()
    // 立刻退出，把舞台让给带旗标的子进程（否则两个实例会抢单实例锁）。
    // 用 process.exit 而不是 app.exit：这个分支必须**立即终止模块求值**，
    // 否则后面会继续注册窗口、抢单实例锁，和子进程打架。
    process.exit(0)
  } catch (err) {
    console.error('[gpu] 软件渲染重拉失败，退化为进程内降级', err)
  }
}

if (forceSoftware || recoveredFromCrash) {
  // ⚠️ 这里的组合是**实测**出来的，改动前先读下面这段，别凭直觉"优化"。
  //
  // 本机（Windows 11 / 软件渲染受限环境）实测：
  //   - `--disable-gpu` 单独用 → **能正常起来**（GPU 进程不再被拉起，不会 FATAL）
  //   - 之前用的 `use-gl=angle + use-angle=swiftshader + enable-unsafe-swiftshader`
  //     → **照样 FATAL** `GPU process isn't usable. Goodbye.`
  //       （SwiftShader 自己在这个环境里起不来，退出码 -1073741819 = 0xC0000005 访问冲突）
  //   也就是说：**主动指定 SwiftShader 比不指定更糟** —— 它把"降级到软件渲染"变成了"再崩一次"。
  //
  // 注：打包场景下旗标已经由上面的"重拉"逻辑写进命令行生效；
  // 这里保留 appendSwitch 是给**非打包**场景兜底（`npm run dev:sw` 直接带 --sw-gl 进来）。
  // 这两行对已经由命令行生效的进程是幂等无害的。
  //
  // 自愈只做最保守的事：**彻底不启用 GPU**（`disable-gpu` 会让 Chromium 走 CPU 光栅化，
  // 不依赖任何 GL 后端，因此不会踩到 SwiftShader 的坑）。
  const swMode = process.env.CANMOUGUAN_SW_MODE || 'disable-gpu'
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  // 兜底开关：如果哪天 `disable-gpu` 也不够（比如需要 WebGL 才能跑），
  // 设 CANMOUGUAN_SW_MODE=swiftshader 换回 ANGLE/SwiftShader 路线，不用改代码重新打包。
  if (swMode === 'swiftshader') {
    app.commandLine.appendSwitch('use-gl', 'angle')
    app.commandLine.appendSwitch('use-angle', 'swiftshader')
    app.commandLine.appendSwitch('enable-unsafe-swiftshader')
  }
  console.log(
    forceSoftware
      ? `[gpu] 已启用软件渲染（模式=${swMode}，来自 --sw-gl）`
      : `[gpu] 检测到上次启动未能加载完成，本次自动改用软件渲染（模式=${swMode}）`
  )
  // 只有在明确走软件渲染时才有必要关掉硬件加速。
  // 正常有 GPU 的机器上无条件 disableHardwareAcceleration() 会让毛玻璃合成、
  // 长列表滚动全部退化到 CPU，白白损失流畅度。
  app.disableHardwareAcceleration()
}

// 必须在 whenReady 之前写下标记：GPU 崩溃发生在窗口创建之前，没有比这更早的时机。
markStartupPending()

app.whenReady().then(() => {
  const settings = loadSettings()

  // 知识库初始化（首次运行写入示例 MD）
  const kbDir = settings.knowledgeDir || getDefaultKnowledgeDir()
  loadKnowledge(kbDir)
  watchKnowledge(kbDir)
  applyRetention()

  // 恢复上次未正常结束的面试（崩溃 / 强制退出遗留），让用户还能补复盘
  const restored = restoreCurrentSession()
  if (restored) {
    console.log(
      `[app] 检测到上次未结束的会话：${restored.company || '未命名'}，转写 ${restored.transcripts.length} 条`
    )
  }

  setupPermissions()
  wireHotkeys()
  registerIPC()
  const mainWin = createMainWindow()
  // 启动成功就把崩溃标记清掉，下次恢复"先试硬件渲染"。
  // 双保险：did-finish-load 走快路径；dev 下页面加载失败（dev server 没起）时不会触发它，
  // 所以再加一个兜底定时器 —— 只要进程活过 10 秒就说明 GPU 没把我们干掉。
  mainWin.webContents.once('did-finish-load', () => markStartupOk())
  setTimeout(() => markStartupOk(), 10000)
  setupTray()
  setupEditMenu()

  if (restored) {
    setTimeout(() => {
      broadcast('toast', {
        text: `已恢复上次未结束的面试（${restored.company || '未命名'}），可在对话页结束后复盘`,
        level: 'warn'
      })
      broadcast('session:changed', restored)
    }, 1200)
  }

  const results = registerAllHotkeys()
  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    console.warn('[hotkey] 部分快捷键注册失败：', failed)
    setTimeout(() => {
      broadcast('toast', {
        text: `${failed.length} 个快捷键注册失败（可能被占用）：${failed.map((f) => f.accelerator).join(', ')}`,
        level: 'warn'
      })
    }, 1500)
  }

  // 状态变更下发给渲染层
  windowEvents.on('state', (s) => broadcast('window:state', s))
  knowledgeEvents.on('reloaded', (docs) => broadcast('kb:changed', docs))
  memoryEvents.on('changed', () => broadcast('memory:changed', {}))
  memoryEvents.on('session', (s) => broadcast('session:changed', s))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    else showWindow()
  })
})

app.on('window-all-closed', () => {
  // 常驻托盘，不因关窗退出
  if (process.platform !== 'darwin') {
    /* 保持运行 */
  }
})

app.on('before-quit', () => {
  // 面试进行中直接退出：先把材料归档，否则这场面试等于白录
  const archived = archiveCurrentSession()
  if (archived) {
    console.log('[app] 退出时归档未结束的会话', archived.id)
  }
})

app.on('will-quit', () => {
  // 按「先断外，再放内」的顺序收尾：连接和流先停，再关文件监听与系统资源。
  // 只 unregisterAllHotkeys 是不够的 —— 转写 WebSocket、在途 LLM 流、
  // 音频缓冲、目录监听、托盘都会随进程遗留。
  console.log('[app] 收尾：释放转写连接 / 在途 LLM 流 / 音频缓冲 / 目录监听 / 托盘 / 快捷键')
  disposeRuntime()
  closeKnowledgeWatcher()
  if (tray) {
    tray.destroy()
    tray = null
  }
  unregisterAllHotkeys()
  console.log('[app] 收尾完成')
})

export {}
