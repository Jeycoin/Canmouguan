/** 临时探针：同一页面并排对比「旧穿透态(0.55)」与「修复后穿透态」的可读性 */
const { app, BrowserWindow, screen } = require('electron')
const path = require('path')
const fs = require('fs')

const root = path.join(__dirname, '..')
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('use-gl', 'angle')
app.commandLine.appendSwitch('use-angle', 'swiftshader')
app.commandLine.appendSwitch('enable-unsafe-swiftshader')

const OUT = path.join(root, '_probe')

app.whenReady().then(async () => {
  const wa = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    width: Math.min(1080, wa.width - 40),
    height: Math.min(700, wa.height - 60),
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2 && !String(msg).includes('Security Warning')) console.log('[renderer]', msg)
  })

  await win.loadFile(path.join(OUT, 'click-through.html'))
  await new Promise((r) => setTimeout(r, 1500))

  const shot = async (label, n = 0) => {
    try {
      const buf = (await win.webContents.capturePage()).toPNG()
      if (!buf.length) throw new Error('empty')
      fs.writeFileSync(path.join(OUT, label + '.png'), buf)
      console.log('OK', label)
    } catch (e) {
      if (n < 3) { await new Promise((r) => setTimeout(r, 800)); return shot(label, n + 1) }
      console.log('FAIL', label, e.message)
    }
  }

  // 预热：首次 capturePage 在软件渲染下常抛 UnknownVizError
  await shot('_warmup')
  fs.rmSync(path.join(OUT, '_warmup.png'), { force: true })

  const probe = await win.webContents.executeJavaScript(`(() => {
    const pick = (id) => {
      const el = document.getElementById(id);
      const cs = getComputedStyle(el);
      return {
        background: cs.backgroundColor,
        textColor: getComputedStyle(el.querySelector('.demo')).color,
        borderColor: cs.borderTopColor
      };
    };
    return { 修复前: pick('legacy'), 修复后: pick('fixed') };
  })()`)
  console.log('并排对比 =', JSON.stringify(probe, null, 2))

  await shot('compare-click-through')

  app.quit()
})
