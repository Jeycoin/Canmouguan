/**
 * 纯 Node 直连对照：绕开 Electron，用同一份 Key 打同一个接口。
 *
 * 目的只有一个 —— 把「Electron / 本项目架构」这个变量彻底排除掉：
 *   若直连也很慢  → 慢的是供应商接口或网络，属于外部因素
 *   若直连很快    → 慢的是本项目的客户端配置（代理、重试、SDK 参数等）
 *
 * 用法：
 *   node scripts/bench-api.js --key=<KEY> [--model=glm-5.3-flash] [--image=路径]
 */
const fs = require('node:fs')
const OpenAI = require('openai')

function argValue(name) {
  const prefix = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

const apiKey = argValue('key')
if (!apiKey) {
  console.error('缺少 --key=<API_KEY>')
  process.exit(1)
}
const model = argValue('model') || 'glm-5.3-flash'
const imagePath = argValue('image')
const baseURL = argValue('base') || 'https://open.bigmodel.cn/api/paas/v4'

const client = new OpenAI({ apiKey, baseURL, timeout: 120000, maxRetries: 0 })

async function measureStream(label, messages) {
  const t0 = Date.now()
  let ttft = -1
  let firstChunkAt = -1
  let chunks = 0
  let text = ''
  try {
    const stream = await client.chat.completions.create({ model, messages, stream: true, max_tokens: 512 })
    for await (const part of stream) {
      const now = Date.now()
      if (firstChunkAt < 0) firstChunkAt = now
      chunks++
      const delta = part.choices?.[0]?.delta?.content
      if (delta) {
        if (ttft < 0) ttft = now
        text += delta
      }
    }
  } catch (err) {
    console.log(`  ${label.padEnd(22)} 请求失败：${err.message}`)
    return
  }
  const total = Date.now() - t0
  console.log(
    `  ${label.padEnd(22)} 首帧=${String(firstChunkAt < 0 ? -1 : firstChunkAt - t0).padStart(6)}ms` +
      `　首个文字=${String(ttft < 0 ? -1 : ttft - t0).padStart(6)}ms` +
      `　总=${String(total).padStart(6)}ms　chunks=${String(chunks).padStart(4)}　字数=${text.length}`
  )
}

async function measureOnce(label, messages) {
  const t0 = Date.now()
  try {
    const res = await client.chat.completions.create({ model, messages, stream: false, max_tokens: 512 })
    const total = Date.now() - t0
    const text = res.choices?.[0]?.message?.content ?? ''
    console.log(`  ${label.padEnd(22)} 非流式总耗时=${String(total).padStart(6)}ms　字数=${text.length}`)
    console.log(`    首 80 字：${text.slice(0, 80).replace(/\n/g, ' ')}`)
  } catch (err) {
    console.log(`  ${label.padEnd(22)} 请求失败：${err.message}`)
  }
}

async function main() {
  console.log(`\n纯 Node 直连 ${baseURL}　model=${model}`)
  console.log('--- 文本 ---')
  await measureStream('文本·流式', [{ role: 'user', content: '用一句话说明什么是 MVCC' }])
  await measureOnce('文本·非流式', [{ role: 'user', content: '用一句话说明什么是 MVCC' }])

  if (imagePath) {
    console.log('--- 图片 ---')
    const b64 = fs.readFileSync(imagePath).toString('base64')
    const mime = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
    const url = `data:${mime};base64,${b64}`
    console.log(`  图片 ${(b64.length / 1024).toFixed(0)} KB(base64)`)
    await measureStream('图片·流式', [
      { role: 'user', content: [{ type: 'text', text: '简述图中的内容' }, { type: 'image_url', image_url: { url } }] }
    ])
    await measureOnce('图片·非流式', [
      { role: 'user', content: [{ type: 'text', text: '简述图中的内容' }, { type: 'image_url', image_url: { url } }] }
    ])
  } else {
    console.log('\n（加 --image=xxx.png 可附带图片对照）')
  }
}

void main()
