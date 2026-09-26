/**
 * 性能基准：定位「回答慢」到底是 API 慢还是本地链路慢。
 *
 * 思路：把一次图片问答拆成本地可测的几段，并用**对照实验**分离变量。
 *   A. 截图链路   —— getSources / crop+resize / base64 编码，各自耗时
 *   B. IPC 负重   —— dataUrl 体积（渲染层与主进程之间要来回传两趟）
 *   C. 模型链路   —— 接到本地 mock OpenAI 服务，排除公网 RTT，看纯属本地的开销
 * 跑完后拿本地 mock 的 TTFT 和你真实供应商的 TTFT 对比，差值即「API/网络」的账。
 *
 * 用法：
 *   npm run bench                              # 只跑本地 mock（不联网，不花钱）
 *   npm run bench -- --real                    # 额外用 settings.json 里已配好的供应商跑一遍
 *   npm run bench -- --key=<API_KEY> --real    # 顺带把 Key 加密写进配置再跑（Key 不会进仓库）
 *   npm run bench -- --model=<模型名>           # 覆盖模型（默认 glm-5.3-flash）
 */
const http = require('node:http')
const path = require('node:path')
const { app, desktopCapturer, screen } = require('electron')

app.commandLine.appendSwitch('no-sandbox')

const root = path.join(__dirname, '..')

// 与真实主进程用同一份数据目录（含改名时的旧目录搬迁），否则读不到已保存的供应商配置
require(path.join(root, 'dist-electron/main/appdir.js')).pinUserDataDir()

const store = require(path.join(root, 'dist-electron/main/store.js'))
const capture = require(path.join(root, 'dist-electron/main/capture.js'))
const llm = require(path.join(root, 'dist-electron/main/llm.js'))

const MB = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`
const KB = (n) => `${(n / 1024).toFixed(0)} KB`

/* ------------------------- 本地 mock OpenAI 服务 ------------------------- */

/**
 * 一个最小可用的 OpenAI 兼容流式服务。
 * 刻意把「首字延迟」和「吐字间隔」设成常量，这样测出来的额外耗时全部是本项目的开销。
 */
function startMockServer({ firstTokenMs = 200, chunkIntervalMs = 20, chunks = 40 }) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let payload = {}
      try {
        payload = JSON.parse(body || '{}')
      } catch {
        /* ignore */
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      // 先推一个注释帧，把响应头刷出去，等价于服务端"接受请求"的时刻
      res.write(': accepted\n\n')

      let sent = 0
      const timer = setInterval(() => {
        if (sent >= chunks) {
          clearInterval(timer)
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        if (sent === 0) {
          // 首个 delta 之前额外等待，模拟模型思考时间
          sent++
          setTimeout(() => {
            writeChunk(payload, res, 0)
          }, firstTokenMs)
          return
        }
        writeChunk(payload, res, sent)
        sent++
      }, chunkIntervalMs)
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function writeChunk(payload, res, idx) {
  const piece = JSON.stringify({
    choices: [{ delta: { content: `字${idx}` }, index: 0 }],
    created: Date.now(),
    model: payload.model || 'mock'
  })
  res.write(`data: ${piece}\n\n`)
}

function estimateImageBytes(payload) {
  try {
    for (const m of payload.messages || []) {
      const content = Array.isArray(m.content) ? m.content : [{ content: m.content }]
      for (const part of content) {
        if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
          return part.image_url.url.length
        }
      }
    }
  } catch {
    /* ignore */
  }
  return 0
}

/* ------------------------------ 计时工具 ------------------------------ */

async function timed(name, fn) {
  const t0 = Date.now()
  const r = await fn()
  const dt = Date.now() - t0
  console.log(`  ${name.padEnd(28)} ${String(dt).padStart(7)} ms`)
  return { r, dt }
}

/* -------------------------------- 主流程 -------------------------------- */

/* ------------------------------ 命令行参数 ------------------------------ */

function argValue(name) {
  const prefix = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

/**
 * 把 Key 写进应用配置（走 safeStorage 加密，和 UI 里「填写 API Key」完全同一条路径）。
 * Key 只存在于命令行参数与加密后的 settings.json，不会进任何仓库文件。
 */
function installKey(rawKey, model, visionModel) {
  const s = store.loadSettings()
  const baseURL = 'https://open.bigmodel.cn/api/paas/v4'
  const vision = visionModel || model
  let profile = s.llm.profiles.find((p) => p.id === 'bench-zhipu')
  if (!profile) {
    profile = {
      id: 'bench-zhipu',
      name: '智谱 BigModel（bench）',
      baseURL,
      model,
      visionModel: vision,
      temperature: 0.3,
      maxTokens: 1024,
      timeoutMs: 60000,
      retries: 1
    }
    s.llm.profiles.push(profile)
  }
  profile.model = model
  profile.visionModel = vision
  profile.baseURL = baseURL
  profile.apiKeyEnc = store.encryptSecret(rawKey)
  s.llm.activeProfileId = profile.id
  store.saveSettings(s)
  console.log(`已写入 ${profile.name}　model=${model}　vision=${vision}　加密=${String(profile.apiKeyEnc).startsWith('enc:')}`)
  return profile.id
}

app.whenReady().then(async () => {
  const model = argValue('model') || 'glm-5.3-flash'
  const vision = argValue('vision')
  const realProfileId = argValue('key') ? installKey(argValue('key'), model, vision) : undefined

  console.log('\n=== 1. 截图链路（captureScreen） ===')
  let shot = null
  try {
    const { r, dt } = await timed('captureScreen 总计', () => capture.captureScreen())
    shot = r
    console.log(`  结果 ${r.width}x${r.height}（源 ${r.sourceWidth}x${r.height ? r.sourceHeight : '?'}）dataUrl=${MB(r.dataUrl.length)}`)
    if (r.timings) {
      console.log('  分段：')
      for (const [k, v] of Object.entries(r.timings)) {
        console.log(`    - ${k.padEnd(24)} ${String(v).padStart(7)} ms`)
      }
      const rest = dt - Object.values(r.timings).reduce((a, b) => a + b, 0)
      console.log(`    - ${'隐藏/恢复窗口 + 其余'.padEnd(24)} ${String(rest).padStart(7)} ms`)
    }
  } catch (err) {
    console.log(`  截图失败（无权限 / 无显示器环境）：${err.message}`)
  }

  console.log('\n=== 2. 对照：只取一次最小够用的 source ===')
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    await timed('getSources@4096x4096（现网路径）', () =>
      desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 4096, height: 4096 } })
    )
    await timed(`getSources@${display.size.width}x${display.size.height}`, () =>
      desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.max(64, display.size.width), height: Math.max(64, display.size.height) }
      })
    )
    await timed('getSources@64x64（只要 id 时）', () =>
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 64, height: 64 } })
    )
  } catch (err) {
    console.log('  对照测量失败：', err.message)
  }

  if (shot) {
    console.log('\n=== 3. IPC 负重估算 ===')
    const bytes = Buffer.byteLength(shot.dataUrl, 'utf8')
    const t0 = Date.now()
    for (let i = 0; i < 3; i++) JSON.parse(JSON.stringify({ d: shot.dataUrl }))
    const dt = (Date.now() - t0) / 3
    console.log(`  dataUrl 体积 ${MB(bytes)}（base64 相比二进制多 33%）`)
    console.log(`  单次 JSON 序列化估算 ${dt.toFixed(1)} ms —— IPC 每跨进程一次都要付这笔钱`)
    console.log(`  当前链路走两趟：主进程→渲染层(${KB(bytes)})，渲染层→主进程(${KB(bytes)})`)
  }

  console.log('\n=== 4. 模型链路（本地 mock，排除公网 RTT） ===')
  const { server, port } = await startMockServer({})
  // 只改内存中的设置对象，不写盘 —— 不会污染用户真实的 settings.json
  const s = store.loadSettings()
  s.llm.activeProfileId = '__bench__'
  s.llm.profiles = [
    ...s.llm.profiles.filter((p) => p.id !== '__bench__'),
    {
      id: '__bench__',
      name: 'bench-mock',
      baseURL: `http://127.0.0.1:${port}/v1`,
      model: 'mock-text',
      visionModel: 'mock-vision',
      temperature: 0.3,
      maxTokens: 2048,
      timeoutMs: 60000,
      retries: 0,
      apiKeyEnc: store.encryptSecret('sk-bench')
    }
  ]
  llm.clearClientCache()

  async function runStream(label, imageDataUrl) {
    const messages = [
      {
        role: 'user',
        content: imageDataUrl
          ? [
              { type: 'text', text: '描述一下' },
              { type: 'image_url', image_url: { url: imageDataUrl } }
            ]
          : '描述一下'
      }
    ]
    let firstDeltaAt = 0
    let deltas = 0
    let text = ''
    const t0 = Date.now()
    await timed(label, () =>
      llm.streamChat(
        { messages, imageDataUrl, maxContextTurns: 4 },
        {
          onDelta: (d) => {
            if (!firstDeltaAt) firstDeltaAt = Date.now()
            deltas++
            text += d
          },
          onDone: () => {},
          onError: () => {}
        }
      )
    )
    const total = Date.now() - t0
    const ttft = firstDeltaAt ? firstDeltaAt - t0 : -1
    console.log(
      `    TTFT=${String(ttft).padStart(6)} ms　delta 条数=${String(deltas).padStart(4)}` +
        `　总耗时=${String(total).padStart(6)} ms　吞吐=${((text.length / Math.max(1, total)) * 1000).toFixed(0)} 字符/秒`
    )
  }

  await runStream('纯文本（对照）', undefined)
  if (shot) await runStream(`带图 dataUrl=${KB(shot.dataUrl.length)}`, shot.dataUrl)
  // 对照二：同样一张图压成缩略图再发 —— 用来判断"图片体积"对 TTFT 到底值多少毫秒
  const thumbUrl = shot ? capture.thumbnailFromDataUrl(shot.dataUrl, 640, 75) : ''
  if (shot) await runStream(`带压缩缩略图 ${KB(thumbUrl.length)}`, thumbUrl)

  const wantReal = process.argv.includes('--real')
  if (wantReal) {
    console.log('\n=== 5. 真实供应商（settings.json 里的配置） ===')
    let target = realProfileId
    if (!target) {
      const withKey = s.llm.profiles.filter((p) => p.id !== '__bench__' && p.apiKeyEnc)
      target = withKey[0]?.id
    }
    if (!target) {
      console.log('  没有可用的真实 Key，跳过。用法：npm run bench -- --key=<KEY> --real')
    } else {
      const profile = s.llm.profiles.find((p) => p.id === target)
      s.llm.activeProfileId = target
      llm.clearClientCache()
      console.log(`  profile=${profile.id} baseURL=${profile.baseURL} model=${profile.model}`)
      await runStream('真实·纯文本', undefined)
      if (shot) await runStream(`真实·带图 ${KB(shot.dataUrl.length)}`, shot.dataUrl)
      if (shot) await runStream(`真实·带压缩图 ${KB(thumbUrl.length)}`, thumbUrl)

      console.log('\n--- 设置页「测试连接」按钮的实际输出 ---')
      const t = await llm.testLLM()
      console.log(`  ok=${t.ok}  latencyMs=${t.latencyMs ?? 'n/a'}`)
      console.log(t.message.split('\n').map((l) => `  ${l}`).join('\n'))
    }
  }

  server.close()
  app.quit()
})
