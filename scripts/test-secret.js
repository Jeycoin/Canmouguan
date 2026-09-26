/**
 * API Key 持久化回归测试（真实代码路径，非 mock）
 *
 * 运行：npm run test:secret
 *
 * 覆盖：
 *  1. 每个配置项独立保存各自的 Key
 *  2. 切换 activeProfileId 后所有 Key 仍在
 *  3. 任意 settings:patch（改温度/模型/STT 参数）不会清空 Key
 *  4. 脱敏下发到渲染层后（apiKeyEnc 被剥离）再回写，Key 不丢
 *  5. 重新加载（模拟重启）后 Key 仍在
 *  6. 用户主动清空时才真正清除
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

// 用独立临时 userData，避免污染真实配置
const { app } = require('electron')

// 该测试不创建窗口，但仍关掉 GPU 以避免无关噪音
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('use-angle', 'swiftshader')
app.commandLine.appendSwitch('enable-unsafe-swiftshader')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-secret-test-'))
app.setPath('userData', tmpDir)

const store = require(path.join(__dirname, '..', 'dist-electron', 'main', 'store.js'))
const { registerIPC } = require(path.join(__dirname, '..', 'dist-electron', 'main', 'ipc.js'))

let failed = 0
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}${extra ? ' → ' + extra : ''}`)
  }
}

function keyOf(profileId) {
  const s = store.getSettings()
  const p = s.llm.profiles.find((x) => x.id === profileId)
  return store.decryptSecret(p && p.apiKeyEnc)
}
function sttKey() {
  return store.decryptSecret(store.getSettings().stt.apiKeyEnc)
}

/**
 * 模拟渲染层：
 * 1. 拿到 settings:get 返回的脱敏副本（apiKeyEnc 已被剥离）
 * 2. 在副本上做修改（这就是 SettingsPanel 里 patch({llm: {...settings.llm, ...}}) 的来源）
 * 3. 回写给主进程
 * 这正是触发 bug 的真实路径。
 */
function patchLikeRenderer(mutate) {
  const s = JSON.parse(JSON.stringify(store.getSettings()))
  for (const p of s.llm.profiles) {
    p.apiKeyMasked = store.mask(store.decryptSecret(p.apiKeyEnc))
    delete p.apiKeyEnc
  }
  s.stt.apiKeyMasked = store.mask(store.decryptSecret(s.stt.apiKeyEnc))
  delete s.stt.apiKeyEnc

  mutate(s)
  return store.patchSettings(s)
}

async function main() {
  console.log('\n[1] 两个配置各自保存独立的 Key')
  store.saveSettings(store.defaultSettings())
  store.patchSettings({ llm: { ...store.getSettings().llm, activeProfileId: 'preset-qwen' } })
  const ids = store.getSettings().llm.profiles.map((p) => p.id)
  const [A, B] = ids
  store.saveSettings(store.getSettings())
  // 直接走 store 层写入
  const s0 = store.getSettings()
  s0.llm.profiles[0].apiKeyEnc = store.encryptSecret('sk-AAA-1111')
  s0.llm.profiles[1].apiKeyEnc = store.encryptSecret('sk-BBB-2222')
  s0.stt.apiKeyEnc = store.encryptSecret('sk-STT-9999')
  store.saveSettings(s0)
  check('配置A = sk-AAA-1111', keyOf(A) === 'sk-AAA-1111', keyOf(A))
  check('配置B = sk-BBB-2222', keyOf(B) === 'sk-BBB-2222', keyOf(B))
  check('两个 Key 互不相同', keyOf(A) !== keyOf(B))

  console.log('\n[2] 切换当前配置为 B（模拟渲染层回写脱敏后的完整设置）')
  patchLikeRenderer((s) => {
    s.llm.activeProfileId = B
  })
  check('activeProfileId 已切到 B', store.getSettings().llm.activeProfileId === B)
  check('切换后 A 的 Key 仍在', keyOf(A) === 'sk-AAA-1111', `实际=${keyOf(A) || '(空)'}`)
  check('切换后 B 的 Key 仍在', keyOf(B) === 'sk-BBB-2222', `实际=${keyOf(B) || '(空)'}`)

  console.log('\n[3] 再切回 A')
  patchLikeRenderer((s) => {
    s.llm.activeProfileId = A
  })
  check('activeProfileId 已切回 A', store.getSettings().llm.activeProfileId === A)
  check('切回后 A 的 Key 仍在', keyOf(A) === 'sk-AAA-1111', `实际=${keyOf(A) || '(空)'}`)
  check('切回后 B 的 Key 仍在', keyOf(B) === 'sk-BBB-2222', `实际=${keyOf(B) || '(空)'}`)

  console.log('\n[4] 修改其它字段（温度 / 模型 / STT 模式）不应影响 Key')
  patchLikeRenderer((s) => {
    s.llm.profiles[0].temperature = 0.9
    s.llm.profiles[1].model = 'qwen-max'
    s.stt.mode = 'file'
    s.stt.model = 'paraformer-v2'
  })
  check('温度已改', store.getSettings().llm.profiles[0].temperature === 0.9)
  check('A 的 Key 未被覆盖', keyOf(A) === 'sk-AAA-1111', `实际=${keyOf(A) || '(空)'}`)
  check('B 的 Key 未被覆盖', keyOf(B) === 'sk-BBB-2222', `实际=${keyOf(B) || '(空)'}`)
  check('STT Key 未被覆盖', sttKey() === 'sk-STT-9999', `实际=${sttKey() || '(空)'}`)

  console.log('\n[5] 重新加载（模拟重启应用）')
  store.resetCacheForTest()
  check('重载后 A 的 Key 仍在', keyOf(A) === 'sk-AAA-1111', `实际=${keyOf(A) || '(空)'}`)
  check('重载后 B 的 Key 仍在', keyOf(B) === 'sk-BBB-2222', `实际=${keyOf(B) || '(空)'}`)
  check('重载后 STT Key 仍在', sttKey() === 'sk-STT-9999', `实际=${sttKey() || '(空)'}`)

  console.log('\n[6] 脱敏下发：渲染层拿到的设置里不含明文/密文 Key')
  registerIPC()
  const { ipcMain } = require('electron')
  const handlers = {}
  const orig = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (ch, fn) => {
    handlers[ch] = fn
  }
  registerIPC()
  ipcMain.handle = orig
  const view = await handlers['settings:get']({}, {})
  check('settings:get 不含 apiKeyEnc', JSON.stringify(view).indexOf('apiKeyEnc') === -1)
  check('settings:get 含脱敏展示值', !!view.llm.profiles[0].apiKeyMasked)

  console.log('\n[7] 端到端：真实 IPC 通道（完全复刻 SettingsPanel 的调用）')
  // 重新灌入 Key
  const base = store.getSettings()
  base.llm.profiles[0].apiKeyEnc = store.encryptSecret('sk-AAA-1111')
  base.llm.profiles[1].apiKeyEnc = store.encryptSecret('sk-BBB-2222')
  base.stt.apiKeyEnc = store.encryptSecret('sk-STT-9999')
  store.saveSettings(base)

  // 7a. 用 setSecret 通道给 A 写入新 Key
  await handlers['settings:setSecret']({}, { scope: 'llm', profileId: A, value: 'sk-NEW-AAAA' })
  let v = await handlers['settings:get']({}, {})
  check('setSecret 后 A 展示脱敏值', !!v.llm.profiles.find((p) => p.id === A).apiKeyMasked)

  // 7b. 切换当前配置 —— 前端就是这么调的：patch({llm:{...settings.llm, activeProfileId}})
  v = await handlers['settings:get']({}, {})
  await handlers['settings:patch'](
    {},
    { llm: { ...JSON.parse(JSON.stringify(v.llm)), activeProfileId: B } }
  )
  v = await handlers['settings:get']({}, {})
  const pa = v.llm.profiles.find((p) => p.id === A)
  const pb = v.llm.profiles.find((p) => p.id === B)
  check('切到 B 后，A 的 Key 仍展示为已保存', !!pa.apiKeyMasked, `A=${JSON.stringify(pa.apiKeyMasked)}`)
  check('切到 B 后，B 的 Key 仍展示为已保存', !!pb.apiKeyMasked, `B=${JSON.stringify(pb.apiKeyMasked)}`)
  check('activeProfileId 确为 B', v.llm.activeProfileId === B)

  // 7c. 切回 A
  v = await handlers['settings:get']({}, {})
  await handlers['settings:patch'](
    {},
    { llm: { ...JSON.parse(JSON.stringify(v.llm)), activeProfileId: A } }
  )
  v = await handlers['settings:get']({}, {})
  check(
    '切回 A 后，A 的 Key 仍展示为已保存',
    !!v.llm.profiles.find((p) => p.id === A).apiKeyMasked
  )
  check('A 的明文确为最新写入的 sk-NEW-AAAA', keyOf(A) === 'sk-NEW-AAAA', `实际=${keyOf(A)}`)
  check('B 的明文未被改动', keyOf(B) === 'sk-BBB-2222', `实际=${keyOf(B)}`)

  // 7d. 改 STT 其它字段
  v = await handlers['settings:get']({}, {})
  await handlers['settings:patch'](
    {},
    { stt: { ...JSON.parse(JSON.stringify(v.stt)), mode: 'file', model: 'paraformer-v2' } }
  )
  check('STT 模式已改', store.getSettings().stt.mode === 'file')
  check('STT Key 未被覆盖', sttKey() === 'sk-STT-9999', `实际=${sttKey() || '(空)'}`)

  // 7e. 重启模拟
  store.resetCacheForTest()
  check('重启后 A 仍为 sk-NEW-AAAA', keyOf(A) === 'sk-NEW-AAAA', `实际=${keyOf(A)}`)
  check('重启后 B 仍为 sk-BBB-2222', keyOf(B) === 'sk-BBB-2222', `实际=${keyOf(B)}`)

  console.log('\n[8] 用户主动清空才生效（走 clearSecret 通道）')
  await handlers['settings:clearSecret']({}, { scope: 'llm', profileId: A })
  check('主动清除后 A 为空', keyOf(A) === '', `实际=${keyOf(A)}`)
  check('清除 A 不影响 B', keyOf(B) === 'sk-BBB-2222', `实际=${keyOf(B)}`)
  check('清除 A 不影响 STT', sttKey() === 'sk-STT-9999', `实际=${sttKey()}`)

  console.log('\n[9] 清理临时目录')
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项失败`}\n`)
  process.exit(failed === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((e) => {
  console.error(e)
  process.exit(1)
})
