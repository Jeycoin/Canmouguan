/**
 * 冒烟测试：加载真实主进程 IPC + 构建产物，截图到 smoke.png 后退出。
 * 仅用于本地验证，不参与打包。
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('node:http')

const root = __dirname

// 与主进程保持一致：无 GPU 的环境（CI / 远程桌面 / 沙箱）也能稳定加载。
// 某些机器上 GPU 进程根本起不来（"GPU process isn't usable"），
// 必须强制走 SwiftShader 软件渲染，否则窗口创建即崩。
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('use-gl', 'angle')
app.commandLine.appendSwitch('use-angle', 'swiftshader')
app.commandLine.appendSwitch('enable-unsafe-swiftshader')

// 与真实主进程用同一份数据目录（含改名时的旧目录搬迁），
// 否则冒烟会跑在一个空配置上，脱离真实使用状态。
require(path.join(__dirname, 'dist-electron/main/appdir.js')).pinUserDataDir()

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json'
}

/** 内置静态服务：比 file:// 更接近真实运行环境，也避开某些环境下 file:// 加载失败的问题 */
function serveDist(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0])
      const file = path.join(dir, urlPath === '/' ? 'index.html' : urlPath)
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404)
          res.end('not found')
          return
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
        res.end(data)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      console.log('[smoke] 静态服务已启动 http://127.0.0.1:' + server.address().port)
      resolve(server)
    })
  })
}

app.whenReady().then(async () => {
  // 注册真实 IPC，让渲染层拿到完整设置
  require(path.join(root, 'dist-electron/main/ipc.js')).registerIPC()
  require(path.join(root, 'dist-electron/main/knowledge.js')).loadKnowledge()

  const win = new BrowserWindow({
    width: 560,
    height: 820,
    // 注意：必须显示窗口。隐藏窗口下 capturePage 会拿到 stale 的旧帧，
    // 导致冒烟截图与实际 UI 不一致（排查过一次：DOM 明明切好了，截图却是上个 Tab）。
    show: !process.env.CI,
    webPreferences: {
      preload: path.join(root, 'dist-electron/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) {
      console.log('[renderer error]', message)
      win.webContents.executeJavaScript(`window.__errCount = (window.__errCount || 0) + 1`).catch(() => {})
    }
  })

  const server = await serveDist(path.join(root, 'dist'))
  const url = `http://127.0.0.1:${server.address().port}/`
  try {
    await win.loadURL(url)
  } catch (err) {
    console.log('[smoke] 加载失败：', err.message)
    server.close()
    app.quit()
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 4000))

  /**
   * 截图是**辅助证据**，不是断言 —— 失败不能拖垮冒烟。
   *
   * 软件渲染（SwiftShader / 坏 GPU 自愈后的 `--disable-gpu`）下
   * `capturePage()` 会偶发抛 `UnknownVizError`（Chromium 合成器还没就绪）。
   * 原来这行没有 try/catch，于是**5 个 tab 全部 `errors=0` 通过之后**，
   * 却因为最后一张截图抛异常 → unhandled rejection → 进程退出码 1，
   * 打出的是"失败"，看似功能有问题，实际只是截图没拍到。
   *
   * 现在：重试 3 次，仍失败就打印 WARN 并继续 —— 功能断言已全部通过，
   * 不能因为一张图把整体判定翻成失败。
   */
  const safeShot = async (label, tries = 3) => {
    for (let i = 0; i < tries; i++) {
      try {
        const img = await win.webContents.capturePage()
        return img
      } catch (e) {
        if (i === tries - 1) {
          console.log(`WARN 截图失败（已重试 ${tries} 次，不影响功能判定）：${label}: ${e.message}`)
          return null
        }
        await new Promise((r) => setTimeout(r, 600))
      }
    }
    return null
  }

  const errCount = () => win.webContents.executeJavaScript(`window.__errCount || 0`)

  /** 按可见文字点按钮。找不到返回 false —— 便于把"按钮不存在"报成明确错误。 */
  const clickByText = (txt) =>
    win.webContents.executeJavaScript(
      `(() => {
        const b = Array.from(document.querySelectorAll('button'))
          .find((x) => x.textContent.trim() === ${JSON.stringify(txt)})
        if (!b) return false
        b.click()
        return true
      })()`
    )

  const tabs = await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('.tab')).map(el => el.textContent.trim())`
  )

  /**
   * ---- 未登录分支：登录闸门 ----
   *
   * 真实数据目录里通常没有 token，`App.tsx` 会停在 `<LoginGate />`，
   * 此时**根本没有 `.tab` 元素**。
   *
   * smoke 测的就是真实启动路径，所以这里**不伪造 token 绕过闸门**，
   * 而是把闸门本身当断言对象：它渲染出来了没有、两个模式能不能切、
   * 切过去之后该出现的控件在不在。绕过它等于这一屏从来没被测过。
   */
  if (!tabs.length) {
    const snap = await win.webContents.executeJavaScript(`(() => ({
      hasApp: !!document.querySelector('.app'),
      buttons: Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()),
      text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 240)
    }))()`)

    // 「进程活着」不等于「界面渲染出来了」：加载失败的内置错误页也拿得到 preload 注入的
    // window.canmouguan。必须断言真实 DOM 标志，否则会假通过。
    if (!snap.hasApp) {
      console.log('[smoke] body:', snap.text)
      throw new Error('页面没渲染出 .app（既没有登录闸门也没有主界面）')
    }

    const missing = ['登录', '注册', '账号密码', '手机验证码']
      .filter((n) => !snap.buttons.includes(n))
    if (missing.length) {
      console.log('[smoke] 闸门已有按钮:', snap.buttons.join(' / '))
      throw new Error('登录闸门缺少按钮：' + missing.join('、'))
    }

    // 手机号态：必须出现手机号输入框 + 「获取验证码」
    if (!(await clickByText('手机验证码'))) throw new Error('点不到「手机验证码」')
    await new Promise((r) => setTimeout(r, 300))
    const phoneUi = await win.webContents.executeJavaScript(`({
      input: !!document.querySelector('input[inputmode="numeric"]'),
      send: Array.from(document.querySelectorAll('button'))
        .some(b => /获取验证码|发送中|^\\d+s$/.test(b.textContent.trim()))
    })`)
    if (!phoneUi.input || !phoneUi.send) {
      throw new Error('切到「手机验证码」后没出现手机号输入框 / 获取验证码按钮')
    }

    // 注册态：兑换码只在注册时填，用它判断模式真的切过去了
    if (!(await clickByText('注册'))) throw new Error('点不到「注册」')
    await new Promise((r) => setTimeout(r, 300))
    if (!/兑换码/.test(await win.webContents.executeJavaScript(`document.body.innerText`))) {
      throw new Error('切到「注册」后没出现兑换码输入框')
    }

    // 切回登录态（顺便验证模式可来回切换）
    if (!(await clickByText('登录'))) throw new Error('点不到「登录」')
    await new Promise((r) => setTimeout(r, 300))

    console.log(`TAB[登录闸门] ok, errors=${await errCount()}`)

    const gateShot = await safeShot('smoke')
    if (gateShot) fs.writeFileSync(path.join(root, 'smoke.png'), gateShot.toPNG())

    console.log('SMOKE_OK')
    server.close()
    app.quit()
    return
  }

  // ---- 已登录分支：逐个切换 Tab，捕获各面板的运行时错误 ----
  for (let i = 0; i < tabs.length; i++) {
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('.tab')[${i}].click(); true`
    )
    await new Promise((r) => setTimeout(r, 900))
    console.log(`TAB[${tabs[i]}] ok, errors=${await errCount()}`)
  }

  // 设置页截图（面板最复杂，单独存一张）
  await win.webContents.executeJavaScript(`document.querySelectorAll('.tab')[4].click(); true`)
  await new Promise((r) => setTimeout(r, 1000))
  const settingsShot = await safeShot('smoke-settings')
  if (settingsShot) fs.writeFileSync(path.join(root, 'smoke-settings.png'), settingsShot.toPNG())

  // 回到对话页截图
  await win.webContents.executeJavaScript(`document.querySelectorAll('.tab')[0].click(); true`)
  await new Promise((r) => setTimeout(r, 800))
  const active = await win.webContents.executeJavaScript(
    `document.querySelector('.tab.active')?.textContent.trim() + ' | tabs=' + document.querySelectorAll('.tab').length`
  )
  console.log('ACTIVE_BEFORE_SHOT:', active)
  const img = await safeShot('smoke')
  if (img) fs.writeFileSync(path.join(root, 'smoke.png'), img.toPNG())
  console.log('SMOKE_OK')
  server.close()
  app.quit()
})
