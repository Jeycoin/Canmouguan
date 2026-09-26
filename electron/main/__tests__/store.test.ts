import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { assertSafeKnowledgeDir, writeJsonAtomic, loadSettings, resetCacheForTest, SETTINGS_VERSION } from '../store'
import { baseVars, renderTemplate } from '../prompt'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((name: string) => path.join('/tmp/interview-copilot-test', 'store', name)) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain),
    decryptString: (buf: Buffer) => buf.toString()
  }
}))

describe('assertSafeKnowledgeDir', () => {
  const rejects = (d: unknown, contains = '不能') => {
    expect(() => assertSafeKnowledgeDir(d)).toThrow(contains)
  }

  it('拒绝空值与非字符串', () => {
    rejects('')
    rejects(undefined)
    rejects(42)
  })

  it('拒绝相对路径', () => {
    rejects('knowledge', '绝对路径')
    rejects('./knowledge', '绝对路径')
  })

  it('拒绝磁盘根目录', () => {
    rejects(path.parse(process.cwd()).root, '根目录')
  })

  it('拒绝系统目录本身', () => {
    const systemRoot = process.platform === 'win32' ? process.env.SystemRoot || 'C:\\Windows' : '/System'
    rejects(systemRoot, '系统目录')
  })

  it('拒绝先跳出去再绕回系统目录的路径', () => {
    const systemRoot = process.platform === 'win32' ? process.env.SystemRoot || 'C:\\Windows' : '/System'
    rejects(path.join(systemRoot, '..', path.basename(systemRoot), 'Temp'), '系统目录')
  })

  it('接受用户数据目录下的正当路径', () => {
    const base = path.join('/tmp/interview-copilot-test', 'store', 'userData')
    expect(() => assertSafeKnowledgeDir(path.join(base, 'knowledge'))).not.toThrow()
  })
})

describe('writeJsonAtomic', () => {
  const dir = path.join('/tmp/interview-copilot-test', 'store', 'atomic')
  const file = path.join(dir, 'data.json')

  it('写入后内容是完整合法的 JSON', () => {
    fs.rmSync(dir, { recursive: true, force: true })
    writeJsonAtomic(file, { hello: 'world', nested: { n: [1, 2, 3] } })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ hello: 'world', nested: { n: [1, 2, 3] } })
  })

  it('不残留临时文件', () => {
    writeJsonAtomic(file, { a: 1 })
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('重复写入时是覆盖而不是追加', () => {
    writeJsonAtomic(file, { v: 2 })
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { v: number }
    expect(parsed.v).toBe(2)
  })
})

/**
 * 提示词迁移回归。
 *
 * 背景：默认提示词只在"首次生成设置"时写入 settings.json，之后就是用户自己的副本。
 * 直接把默认值从 Python 改成 Java 对已装机的用户完全无效，必须做定点迁移。
 */
describe('提示词迁移（代码语言 → {{lang}}）', () => {
  const dir = path.join('/tmp/interview-copilot-test', 'store', 'userData')
  const settingsFile = path.join(dir, 'settings.json')

  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true })
    resetCacheForTest()
  })

  it('旧版默认提示词会被迁移，并补上 codeLang 默认值', () => {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        version: 1,
        prompts: {
          system: '你的输出必须：\n2. 结构化：先给一句话结论，再给 3-5 个要点，必要时给代码。\n',
          screenshot: '## 3. 代码实现\n给出完整、可直接运行的代码（优先 {{lang}}，如未指定用 Python）。\n',
          transcript: '- 如果是**技术问题**：给出一句话结论 + 要点 + 必要代码 + 60 秒口语稿。\n'
        },
        interview: { company: '', role: '', jd: '', round: '一面' }
      }),
      'utf8'
    )

    const s = loadSettings()
    expect(s.prompts.screenshot).not.toContain('如未指定用 Python')
    expect(s.prompts.screenshot).toContain('{{lang}} 代码')
    expect(s.prompts.system).toContain('需要写代码时一律使用 {{lang}}')
    expect(s.prompts.transcript).toContain('必要代码（一律用 {{lang}}')
    expect(s.interview.codeLang).toBe('Java')
    // 版本号随提示词迁移推进，这里是"最新版本"而不是 2
    expect(s.version).toBe(SETTINGS_VERSION)

    // 迁移结果必须立刻落盘，否则每次启动都要重算
    const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as {
      prompts: { screenshot: string }
      interview: { codeLang: string }
    }
    expect(onDisk.prompts.screenshot).not.toContain('如未指定用 Python')
    expect(onDisk.interview.codeLang).toBe('Java')
  })

  it('用户自己写过的提示词一个字都不动', () => {
    const custom = '我自己的提示词：请一律用 Go 作答，不要用其它语言。'
    fs.writeFileSync(settingsFile, JSON.stringify({ prompts: { screenshot: custom } }), 'utf8')

    const s = loadSettings()
    expect(s.prompts.screenshot).toBe(custom)
  })
})

/** {{lang}} 的最终渲染结果 —— 这才是用户真正看到的东西 */
describe('{{lang}} 渲染', () => {
  const dir = path.join('/tmp/interview-copilot-test', 'store', 'userData')
  const settingsFile = path.join(dir, 'settings.json')

  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true })
    resetCacheForTest()
  })

  it('默认渲染成 Java', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({}), 'utf8')
    resetCacheForTest()
    expect(renderTemplate('请给出 {{lang}} 代码', baseVars())).toBe('请给出 Java 代码')
  })

  it('改设置后立刻跟着变', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ interview: { codeLang: 'Go' } }), 'utf8')
    resetCacheForTest()
    expect(renderTemplate('请给出 {{lang}} 代码', baseVars())).toBe('请给出 Go 代码')
  })

  it('codeLang 被清空时兜底 Java', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ interview: { codeLang: '   ' } }), 'utf8')
    resetCacheForTest()
    expect(baseVars().lang).toBe('Java')
  })
})

/**
 * 改名后的绝对路径重映射。
 *
 * 真实事故：产品从 Interview Copilot 改名为参谋官后，settings.json 里存着的
 * `knowledgeDir` 仍指向旧目录。应用发现该目录不存在 → 新建 → 又播种了一份默认模板，
 * 于是检索全部命中模板，用户自己写的知识库看起来"凭空消失"（文件其实已随目录搬走）。
 */
describe('绝对路径重映射（改产品名后）', () => {
  const appDataBase = path.join('/tmp/interview-copilot-test', 'store', 'appData')
  const userData = path.join('/tmp/interview-copilot-test', 'store', 'userData')
  const settingsFile = path.join(userData, 'settings.json')

  beforeEach(() => {
    fs.mkdirSync(userData, { recursive: true })
    resetCacheForTest()
  })

  it('旧数据目录下的 knowledgeDir 会被重映射到当前目录', () => {
    const stale = path.join(appDataBase, 'Interview Copilot', 'knowledge')
    fs.writeFileSync(settingsFile, JSON.stringify({ knowledgeDir: stale }), 'utf8')

    const s = loadSettings()
    expect(s.knowledgeDir).toBe(path.join(userData, 'knowledge'))
    // 必须落盘，否则每次启动都要重算，且旧路径一直留在磁盘上
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).knowledgeDir).toBe(path.join(userData, 'knowledge'))
  })

  it('更早的目录名 interview-copilot 同样被重映射', () => {
    const stale = path.join(appDataBase, 'interview-copilot', 'knowledge')
    fs.writeFileSync(settingsFile, JSON.stringify({ knowledgeDir: stale }), 'utf8')

    expect(loadSettings().knowledgeDir).toBe(path.join(userData, 'knowledge'))
  })

  it('指向别处的自定义知识库目录不能被改动', () => {
    const custom = path.join('/tmp', 'my-own-notes')
    fs.writeFileSync(settingsFile, JSON.stringify({ knowledgeDir: custom }), 'utf8')

    expect(loadSettings().knowledgeDir).toBe(custom)
  })

  it('前缀相似但不是子目录的路径不能被误伤', () => {
    // "Interview Copilot-backup" 不是 "Interview Copilot" 的子目录
    const decoy = path.join(appDataBase, 'Interview Copilot-backup', 'knowledge')
    fs.writeFileSync(settingsFile, JSON.stringify({ knowledgeDir: decoy }), 'utf8')

    expect(loadSettings().knowledgeDir).toBe(decoy)
  })
})

/**
 * STT 单源 → 双通道迁移回归。
 *
 * 为什么必须有：老用户只有一个 `audioSource` 选择。通道化之后若直接套用默认
 * （两条通道默认都开），一个"只录会议声音"的用户升级后**自己的麦克风也开始被转写并落库** ——
 * 这是行为静默改变 + 隐私相关，绝不能出错。
 */
describe('STT 双通道迁移', () => {
  const userData = path.join('/tmp/interview-copilot-test', 'store', 'userData')
  const settingsFile = path.join(userData, 'settings.json')

  beforeEach(() => {
    fs.mkdirSync(userData, { recursive: true })
    resetCacheForTest()
  })

  const loadWithStt = (stt: Record<string, unknown>) => {
    fs.writeFileSync(settingsFile, JSON.stringify({ stt }), 'utf8')
    resetCacheForTest()
    return loadSettings()
  }

  it('audioSource=system 的老用户升级后只开面试官通道（不会偷偷开麦克风）', () => {
    const s = loadWithStt({ audioSource: 'system', mode: 'realtime', sendMode: 'auto', model: 'paraformer-realtime-v2' })
    expect(s.stt.channels.interviewer.enabled).toBe(true)
    expect(s.stt.channels.candidate.enabled).toBe(false)
  })

  it('audioSource=mic 的老用户升级后只开我的通道', () => {
    const s = loadWithStt({ audioSource: 'mic', mode: 'realtime', sendMode: 'auto', model: 'paraformer-realtime-v2' })
    expect(s.stt.channels.interviewer.enabled).toBe(false)
    expect(s.stt.channels.candidate.enabled).toBe(true)
  })

  it('audioSource=both 的老用户升级后两条都开（与旧语义一致）', () => {
    const s = loadWithStt({ audioSource: 'both', mode: 'realtime', sendMode: 'auto', model: 'paraformer-realtime-v2' })
    expect(s.stt.channels.interviewer.enabled).toBe(true)
    expect(s.stt.channels.candidate.enabled).toBe(true)
  })

  it('老用户显式设置的全局 mode / sendMode 会被两个通道继承', () => {
    const s = loadWithStt({ audioSource: 'both', mode: 'file', sendMode: 'manual', model: 'paraformer-v2' })
    expect(s.stt.channels.interviewer.mode).toBe('file')
    expect(s.stt.channels.interviewer.sendMode).toBe('manual')
    expect(s.stt.channels.candidate.mode).toBe('file')
    expect(s.stt.channels.candidate.sendMode).toBe('manual')
  })

  it('全新安装走默认值：面试官实时自动发送、我自己停止后上传进输入框', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({}), 'utf8')
    resetCacheForTest()
    const s = loadSettings()
    expect(s.stt.channels.interviewer.mode).toBe('realtime')
    expect(s.stt.channels.interviewer.sendMode).toBe('auto')
    expect(s.stt.channels.candidate.mode).toBe('file')
    expect(s.stt.channels.candidate.sendMode).toBe('edit')
  })

  it('已经是双通道配置的用户不会被重复迁移覆盖', () => {
    const custom = {
      interviewer: { enabled: false, mode: 'file', sendMode: 'manual', realtimeModel: 'x', fileModel: 'y' },
      candidate: { enabled: true, mode: 'realtime', sendMode: 'auto', realtimeModel: 'x', fileModel: 'y' }
    }
    const s = loadWithStt({ audioSource: 'both', mode: 'realtime', sendMode: 'auto', model: 'm', channels: custom })
    expect(s.stt.channels).toEqual(custom)
  })
})
