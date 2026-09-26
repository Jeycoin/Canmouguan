import { BrowserWindow, screen, shell, app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { getSettings, saveSettings } from './store'

export const windowEvents = new EventEmitter()

let win: BrowserWindow | null = null
let isClickThrough = false
let isCollapsed = false
let isHidden = false
let expandedBounds = { width: 0, height: 0 }

const TOP_LEVELS: Record<string, 'normal' | 'floating' | 'torn-off-menu' | 'modal-panel' | 'main-menu' | 'status' | 'pop-up-menu' | 'screen-saver'> = {
  normal: 'normal',
  floating: 'floating',
  'screen-saver': 'screen-saver'
}

/**
 * 判断是否指向本应用自己的入口页（打包后的 dist/index.html，或 dev server 根）。
 *
 * 这里**不能对 `file:` 协议一律放行**（原来的写法就是 return true）。
 * 那等于说"随便跳到哪个本地 html 都算自己人"—— 而 preload 会把 IPC 桥注入到
 * 任何加载进这个 webContents 的页面。一旦哪天渲染层能被诱导导航到本地文件，
 * 那个外来页面就拿到了整个 window.canmouguan。
 * 目前 Markdown 的协议白名单（DOMPurify）挡住了注入面，但这属于"只差一层防护"，
 * 所以收紧成只认确切的 dist/index.html。
 *
 * 用「解码后的路径」而不是 href 字符串比较，避免 Windows 中文路径的
 * percent-encoding 差异导致误判（自己把自己拦了）。
 */
export function isOwnOrigin(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') {
      const ownPath = indexPath().replace(/\\/g, '/').toLowerCase()
      const actual = decodeURIComponent(u.pathname).replace(/^\/+/, '').toLowerCase()
      return actual === ownPath
    }
    const dev = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173'
    return url === dev || url.startsWith(dev)
  } catch {
    return false
  }
}

/** 只有 http/https 才值得交给系统浏览器——file:、javascript:、ms-msdt: 之类一律丢弃 */
function isExternalHttpUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol
    return p === 'http:' || p === 'https:'
  } catch {
    return false
  }
}

function devUrl(): string {
  return process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173'
}

function preloadPath(): string {
  return path.join(__dirname, '..', 'preload', 'index.js')
}

function indexPath(): string {
  return path.join(__dirname, '..', '..', 'dist', 'index.html')
}

/** 把窗口约束到某个可见显示器内，避免多显示器拔插后窗口"消失" */
function clampToDisplay(bounds: { x: number; y: number; width: number; height: number }) {
  const display = screen.getDisplayMatching({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
  const area = display.workArea
  const w = Math.min(bounds.width, area.width)
  const h = Math.min(bounds.height, area.height)
  const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - w))
  const y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - h))
  return { x, y, width: w, height: h }
}

export function createMainWindow(): BrowserWindow {
  const s = getSettings()

  const savedBounds = clampToDisplay({
    x: s.window.x ?? 80,
    y: s.window.y ?? 80,
    width: s.window.width,
    height: s.window.height
  })

  win = new BrowserWindow({
    ...savedBounds,
    minWidth: 320,
    minHeight: 220,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    resizable: true,
    movable: true,
    skipTaskbar: !s.window.showInTaskbar,
    fullscreenable: false,
    // 透明窗口 + 圆角：不使用 vibrancy 以保证 Windows/Linux 一致表现
    titleBarStyle: 'hidden',
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      webSecurity: true
    }
  })

  // 全屏应用之上显示：screen-saver 是 Electron 支持的最高层级
  applyAlwaysOnTop(s.window.alwaysOnTop, s.window.topLevel)

  // 注意：透明度不再调用 win.setOpacity()（整窗压淡，连文字一起变虚）。
  // 改由渲染层用 CSS 变量控制毛玻璃背景的 alpha，见 App.tsx / styles.css。
  if (s.privacy.localOnly) {
    // 本地优先：尽量阻止窗口被截图/录屏捕获
    try {
      win.setContentProtection(s.window.stealthOnShare)
    } catch (err) {
      console.error('[window] 忽略异常', err)
      /* noop */
    }
  }

  // 多显示器：跟随鼠标所在屏幕，macOS 需要 setVisibleOnAllWorkspaces
  if (process.platform === 'darwin') {
    app.dock?.hide()
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  win.once('ready-to-show', () => {
    win?.show()
    isHidden = false
    emitState()
  })

  // moved / resized 在拖动过程中会以几十赫兹触发，原先每次都同步写一次
  // settings.json —— 拖一下窗口就是几十次全量 JSON 落盘。这里做节流落盘。
  let boundsTimer: NodeJS.Timeout | null = null
  const persistBounds = () => {
    if (!win) return
    if (win.isMinimized() || isCollapsed) return
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      boundsTimer = null
      if (!win || win.isDestroyed()) return
      const b = win.getBounds()
      const st = getSettings()
      st.window.x = b.x
      st.window.y = b.y
      st.window.width = b.width
      st.window.height = b.height
      saveSettings(st)
    }, 400)
  }
  win.on('moved', persistBounds)
  win.on('resized', persistBounds)

  win.on('closed', () => {
    if (boundsTimer) {
      clearTimeout(boundsTimer)
      boundsTimer = null
    }
    win = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  /**
   * AI 回答里经常带参考链接，渲染后是普通 <a href="...">。
   * 没有这道拦截时点一下链接会让整个 webContents 直接导航到外站 ——
   * 助手界面被网页顶掉，且外部页面能拿到这个同源上下文。
   * 正确做法是拦下来交给系统浏览器；非 http(s) 的 scheme 直接丢弃，不递给 shell。
   */
  win.webContents.on('will-navigate', (event, url) => {
    if (isOwnOrigin(url)) return
    event.preventDefault()
    if (isExternalHttpUrl(url)) void shell.openExternal(url)
  })

  /**
   * 加载入口页。
   *
   * 原来只有一句 `if (VITE_DEV_SERVER_URL || !app.isPackaged) loadURL(dev)`，
   * 于是**未打包但已构建**的场景（`npm start`）会去连根本没在跑的 Vite dev server →
   * ERR_CONNECTION_REFUSED → 白屏，而且用户看不到任何提示。
   *
   * 现在显式提供「加载已构建产物」的开关 `ELECTRON_LOAD_DIST=1`
   * （`npm start` / `--dist` 会注入），并做两处兜底：
   * - dist/index.html 不存在时（忘了 npm run build）回退 dev server 并打印原因；
   * - 主框架加载失败时打日志，避免再次出现"白屏但不知道为什么"。
   */
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return
    console.error(`[window] 主框架加载失败 code=${code} ${desc} url=${url}`)
  })

  const wantDist = process.env.ELECTRON_LOAD_DIST === '1'
  const distIndex = indexPath()
  if (!wantDist && (process.env.VITE_DEV_SERVER_URL || !app.isPackaged)) {
    void win.loadURL(devUrl())
  } else if (fs.existsSync(distIndex)) {
    void win.loadFile(distIndex)
  } else {
    console.warn(`[window] 未找到 ${distIndex}，回退到 dev server（请先执行 npm run build）`)
    void win.loadURL(devUrl())
  }

  isClickThrough = s.window.clickThroughDefault
  if (isClickThrough) applyClickThrough(true)

  return win
}

export function getMainWindow(): BrowserWindow | null {
  return win
}

function clampOpacity(v: number): number {
  return Math.max(0.15, Math.min(1, v))
}

function emitState() {
  const s = getSettings()
  windowEvents.emit('state', {
    clickThrough: isClickThrough,
    collapsed: isCollapsed,
    hidden: isHidden,
    alwaysOnTop: s.window.alwaysOnTop,
    opacity: s.window.opacity,
    stealth: s.window.stealthOnShare
  })
}

/* ------------------------------ 窗口控制 API ------------------------------ */

export function showWindow() {
  if (!win) return
  if (!win.isVisible()) win.show()
  win.focus()
  isHidden = false
  emitState()
}

export function hideWindow(panic = false) {
  if (!win) return
  win.hide()
  isHidden = true
  if (panic) emitState()
  else emitState()
}

export function toggleWindow() {
  if (!win) return
  if (win.isVisible()) hideWindow()
  else showWindow()
}

export function applyAlwaysOnTop(on: boolean, level = getSettings().window.topLevel) {
  if (!win) return
  win.setAlwaysOnTop(on, TOP_LEVELS[level] ?? 'screen-saver')
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: on })
  const st = getSettings()
  st.window.alwaysOnTop = on
  st.window.topLevel = level
  saveSettings(st)
  emitState()
}

export function toggleAlwaysOnTop(): boolean {
  const next = !getSettings().window.alwaysOnTop
  applyAlwaysOnTop(next)
  return next
}

/**
 * 鼠标穿透：开启后点击直接落到下方窗口，工具不可交互。
 * forward: true 时仍转发鼠标移动事件，便于渲染层做 hover 提示。
 */
export function applyClickThrough(on: boolean) {
  if (!win) return
  isClickThrough = on
  win.setIgnoreMouseEvents(on, { forward: true })
  emitState()
}

export function toggleClickThrough(): boolean {
  applyClickThrough(!isClickThrough)
  return isClickThrough
}

export function isClickThroughOn(): boolean {
  return isClickThrough
}

/**
 * 设置背景不透明度（0.15–1）。
 *
 * 实现方式：只写设置并广播状态，由渲染层把它套到 CSS 变量 --bg-alpha 上——
 * 这样透明度只作用于毛玻璃背景，**文字始终保持 100% 清晰**。
 * 之前用 win.setOpacity() 是整窗不透明度，文字会跟着一起变淡，导致"看不清"。
 */
export function setOpacity(v: number) {
  const val = clampOpacity(v)
  const st = getSettings()
  st.window.opacity = val
  saveSettings(st)
  emitState()
}

export function setStealth(on: boolean) {
  if (!win) return
  try {
    win.setContentProtection(on)
  } catch (err) {
   console.error('[window] 忽略异常', err)
    /* noop */
  }
  const st = getSettings()
  st.window.stealthOnShare = on
  saveSettings(st)
  emitState()
}

export function setCollapsed(on: boolean) {
  if (!win) return
  const s = getSettings()
  if (on && !isCollapsed) {
    expandedBounds = { width: s.window.width, height: s.window.height }
    win.setSize(360, 56, true)
    isCollapsed = true
  } else if (!on && isCollapsed) {
    const w = expandedBounds.width || s.window.width
    const h = expandedBounds.height || s.window.height
    win.setSize(w, h, true)
    isCollapsed = false
  }
  emitState()
}

export function toggleCollapsed(): boolean {
  setCollapsed(!isCollapsed)
  return isCollapsed
}

export function isCollapsedNow(): boolean {
  return isCollapsed
}

/** 把窗口移动到鼠标所在的显示器中心 */
export function moveToCursorDisplay() {
  if (!win) return
  const p = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(p)
  const b = win.getBounds()
  const x = display.workArea.x + Math.round((display.workArea.width - b.width) / 2)
  const y = display.workArea.y + Math.round((display.workArea.height - b.height) / 2)
  win.setPosition(Math.max(display.workArea.x, x), Math.max(display.workArea.y, y), true)
}

export function flashScreenshot(): void {
  if (!win) return
  try {
    win.webContents.send('ui:flash')
  } catch (err) {
   console.error('[window] 忽略异常', err)
    /* noop */
  }
}

export function setTaskbarVisible(v: boolean) {
  if (!win) return
  win.setSkipTaskbar(!v)
  const st = getSettings()
  st.window.showInTaskbar = v
  saveSettings(st)
}

/**
 * 把 `settings.window` 里「必须落到窗口原生属性上」的项重新应用一遍。
 *
 * 为什么非要单独有这么一个函数：`skipTaskbar` 和内容保护只在 `createMainWindow()`
 * 里读过一次。设置面板改完只是 `patchSettings()` + 广播状态，**窗口本身没被碰过**，
 * 于是「在任务栏显示」「屏幕共享时隐藏」这两个开关都要**重启应用才生效** ——
 * 用户点完开关看不到任何变化，会以为功能是坏的。
 *
 * 所以 `settings:patch` 收到 window 相关改动后要调这里。
 */
export function applyWindowSettings() {
  if (!win) return
  const s = getSettings()
  win.setSkipTaskbar(!s.window.showInTaskbar)
  try {
    win.setContentProtection(s.window.stealthOnShare)
  } catch (err) {
    console.error('[window] 设置内容保护失败', err)
  }
  emitState()
}

