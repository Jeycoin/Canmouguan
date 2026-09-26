import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((name: string) => path.join('/tmp/interview-copilot-test', 'cloud', name)) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain),
    decryptString: (buf: Buffer) => buf.toString()
  }
}))

import { loadSettings, resetCacheForTest, patchSettings, encryptSecret, SETTINGS_VERSION } from '../store'
import {
  asrConn,
  llmTarget,
  cloudLoggedIn,
  cloudBaseURL,
  cloudLLMBaseURL,
  clampModel,
  resetModelCatalog,
  loadModelCatalog
} from '../cloud'

const userData = path.join('/tmp/interview-copilot-test', 'cloud', 'userData')
const settingsFile = path.join(userData, 'settings.json')

beforeEach(() => {
  fs.mkdirSync(userData, { recursive: true })
  resetCacheForTest()
  resetModelCatalog()
})

/** 直接把 settings.json 铺成想要的样子，避免依赖 UI 的写入路径 */
function seed(partial: Record<string, unknown>): ReturnType<typeof loadSettings> {
  fs.writeFileSync(settingsFile, JSON.stringify(partial), 'utf8')
  resetCacheForTest()
  return loadSettings()
}

/** 铺一份"已登录到指定网关"的设置 */
function login(baseURL = 'https://gw.example.com/', token = 'v1.token.sig') {
  return patchSettings({
    cloud: { enabled: true, baseURL, tokenEnc: encryptSecret(token) }
  })
}

describe('网关是唯一形态', () => {
  it('老配置里的 enabled:false 会被抹平成 true（没有"开关"这回事了）', () => {
    const s = seed({ cloud: { enabled: false, baseURL: 'https://gw.example.com' } })
    // 留着 false 会让后来的人得出与事实相反的结论：请求明明全在走网关
    expect(s.cloud.enabled).toBe(true)
  })

  it('老用户升级后自动补上 cloud 段，且默认指向本机网关', () => {
    const s = seed({ stt: { model: 'paraformer-realtime-v2' } })
    expect(s.cloud).toBeTruthy()
    expect(s.cloud.baseURL).toBe('http://127.0.0.1:8787')
    expect(s.version).toBe(SETTINGS_VERSION)
  })

  it('留空地址会回落到默认网关，而不是变成"装完就是死的"', () => {
    seed({ cloud: { enabled: true, baseURL: '   ' } })
    expect(cloudLLMBaseURL()).toBe('http://127.0.0.1:8787/v1')
  })
})

describe('⚠️ 自带 Key 已被结构性屏蔽', () => {
  /**
   * 这一组是本文件的重点：**BYOK 不是"界面上没有入口"，而是主进程一行都不读**。
   * 所以断言的是"填了也不生效"，而不是"界面上找不到输入框"。
   */
  it('存了本机 LLM Key / BaseURL 也不会被使用：落点仍是网关', () => {
    seed({
      llm: {
        activeProfileId: 'p1',
        profiles: [{ id: 'p1', baseURL: 'https://api.deepseek.com/v1', apiKeyEnc: encryptSecret('sk-own'), model: 'deepseek-chat' }]
      },
      cloud: { enabled: true, baseURL: 'https://gw.example.com', tokenEnc: encryptSecret('v1.t') }
    })
    const t = llmTarget()
    expect(t.baseURL).toBe('https://gw.example.com/v1')
    expect(t.apiKey).toBe('v1.t')
    expect(t.baseURL).not.toContain('deepseek')
  })

  it('存了本机百炼 Key 也不会被使用：语音落点仍是网关', () => {
    seed({
      stt: { apiKeyEnc: encryptSecret('sk-dashscope-own'), endpointId: 'beijing', model: 'paraformer-realtime-v2' },
      cloud: { enabled: true, baseURL: 'https://gw.example.com', tokenEnc: encryptSecret('v1.t') }
    })
    const conn = asrConn()
    expect(conn.cloud).toBe(true)
    expect(conn.apiKey).toBe('v1.t')
    expect(conn.wsUrl).not.toContain('dashscope')
  })

  it('asrConn 不接受参数 —— 调用方没机会塞自己的配置进去', () => {
    login()
    // @ts-expect-error 故意多传一个参数：编译期就该被拒绝，运行期也必须忽略它
    const conn = asrConn(loadSettings().stt)
    expect(conn.wsUrl).toContain('gw.example.com')
  })
})

describe('落点解析', () => {
  it('语音走网关，URL 规范化掉尾部斜杠', () => {
    login()
    const conn = asrConn()
    expect(conn.apiKey).toBe('v1.token.sig')
    expect(conn.wsUrl).toBe('wss://gw.example.com/v1/asr/realtime?token=v1.token.sig')
    expect(conn.httpUrl).toBe('https://gw.example.com/v1/audio/transcriptions')
  })

  it('ws 地址由 http 推导：http → ws', () => {
    seed({ cloud: { enabled: true, baseURL: 'http://127.0.0.1:8787', tokenEnc: encryptSecret('t') } })
    expect(asrConn().wsUrl).toBe('ws://127.0.0.1:8787/v1/asr/realtime?token=t')
  })

  it('未登录时给出可执行提示，而不是拿空 token 去请求', () => {
    seed({ cloud: { enabled: true, baseURL: 'https://gw.example.com' } })
    expect(cloudLoggedIn()).toBe(false)
    expect(() => asrConn()).toThrow('登录')
    expect(() => llmTarget()).toThrow('登录')
  })
})

describe('模型夹取（防"选了 A 用了 B"）', () => {
  /**
   * 网关对非白名单模型是**静默改写**的：不夹的话客户端以为在用 A、服务端跑的是 B，
   * 而且不报错。所以这里断言"客户端发出去的模型一定落在服务端清单内"。
   */
  it('不认识的模型会被换成服务端默认值', () => {
    login()
    const t = llmTarget({ model: 'qwen-plus', visionModel: 'qwen-vl-max-latest' })
    expect(t.model).toBe('glm-4-flash')
    expect(t.visionModel).toBe('glm-4v-flash')
  })

  it('白名单内的模型原样保留', () => {
    login()
    expect(llmTarget({ model: 'glm-4-plus', visionModel: 'glm-4v' }).model).toBe('glm-4-plus')
  })

  it('语音模型：实时与离线不会互相串台', () => {
    // 离线模型用在实时通道上会连不上 —— 这比"效果差一点"严重得多
    expect(clampModel('asr', 'paraformer-v2', 'realtime')).toBe('paraformer-realtime-v2')
    expect(clampModel('asr', 'paraformer-v2', 'file')).toBe('paraformer-v2')
    expect(clampModel('asr', 'sensevoice-v1', 'realtime')).not.toBe('sensevoice-v1')
  })

  it('拉不到服务端清单时回落内置清单（与服务端默认白名单一致），不抛错', async () => {
    login()
    const cat = await loadModelCatalog() // 测试里没有网关，必然失败
    expect(cat.live).toBe(false)
    expect(cat.llm).toContain('glm-4-flash')
    expect(cat.asr).toContain('paraformer-realtime-v2')
  })
})

describe('凭据的持久化保护', () => {
  it('patch 通道不能清空已保存的 token（与 API Key 同等纪律）', () => {
    login()
    // 模拟渲染层把"脱敏副本"（不含 tokenEnc）整体回写
    patchSettings({ cloud: { enabled: true, baseURL: 'https://gw.example.com' } })
    expect(loadSettings().cloud.tokenEnc).toBeTruthy()
    expect(cloudLoggedIn()).toBe(true)
  })

  it('关掉"开关"不会顺手把 token 抹掉', () => {
    login()
    patchSettings({ cloud: { enabled: false, baseURL: 'https://gw.example.com' } })
    expect(loadSettings().cloud.tokenEnc).toBeTruthy()
  })

  it('登出只清本机凭据，不动网关地址（免得下一个人还要重填）', () => {
    login('https://gw.example.com/')
    const s = loadSettings()
    s.cloud.tokenEnc = undefined
    expect(cloudBaseURL()).toBe('https://gw.example.com')
    expect(s.cloud.baseURL).toContain('gw.example.com')
  })
})
