import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  importMemories,
  searchMemories,
  listMemories,
  clearMemories,
  startSession,
  addTranscript,
  endSession,
  restoreCurrentSession,
  listSessions,
  clearAllHistory,
  applyRetention,
  currentSessionOrNull,
  sessionMaterial
} from '../memory'
import { getSettings, saveSettings } from '../store'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((name: string) => path.join('/tmp/interview-copilot-test', 'memory', name)) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain),
    decryptString: (buf: Buffer) => buf.toString()
  }
}))

describe('importMemories', () => {
  beforeEach(() => clearMemories())

  it('拒绝非 JSON 输入', () => {
    expect(() => importMemories('not json')).toThrow('有效 JSON')
  })

  it('拒绝缺少 question 的条目', () => {
    expect(() => importMemories(JSON.stringify({ version: 1, items: [{ referenceAnswer: 'foo' }] }))).toThrow(
      '格式校验失败'
    )
  })

  it('导入有效条目并去重', () => {
    const json = JSON.stringify({
      version: 1,
      items: [{ question: 'Q1', knowledgePoints: ['A'], mastery: 3 }]
    })
    expect(importMemories(json)).toBe(1)
    expect(listMemories()[0].question).toBe('Q1')

    // 再次导入相同 question 应合并，不新增
    expect(importMemories(json)).toBe(0)
    expect(listMemories().length).toBe(1)
  })
})

describe('searchMemories', () => {
  beforeEach(() => clearMemories())

  it('按文本查询返回匹配条目', () => {
    importMemories(
      JSON.stringify({
        version: 1,
        items: [
          { question: 'Redis 持久化', referenceAnswer: 'RDB 和 AOF', tags: ['redis'] },
          { question: 'TCP 三次握手', referenceAnswer: 'SYN ACK', tags: ['network'] }
        ]
      })
    )
    const hits = searchMemories({ text: 'Redis', topK: 5 })
    expect(hits.length).toBe(1)
    expect(hits[0].question).toBe('Redis 持久化')
  })

  it('未命中时返回空数组', () => {
    importMemories(JSON.stringify({ version: 1, items: [{ question: 'TCP 三次握手' }] }))
    expect(searchMemories({ text: 'xyz123', topK: 5 })).toEqual([])
  })
})

/**
 * 会话持久化回归。
 *
 * 之前 currentSession 只活在内存里，只有主动「结束面试」才落盘，
 * 崩溃 / 强退会让整场面试的转写蒸发。下面是对应的关键保证。
 */
describe('面试会话持久化', () => {
  const currentFile = path.join('/tmp/interview-copilot-test', 'memory', 'userData', 'session-current.json')

  beforeEach(() => clearAllHistory())

  it('进行中会话随材料变更实时落盘', () => {
    const s = startSession({ company: 'A 公司', role: '后端', round: '一面' })
    addTranscript('请介绍一下 Redis 的持久化机制')

    expect(fs.existsSync(currentFile)).toBe(true)
    const raw = JSON.parse(fs.readFileSync(currentFile, 'utf8')) as typeof s
    expect(raw.id).toBe(s.id)
    expect(raw.transcripts).toHaveLength(1)
    expect(raw.transcripts[0].text).toContain('Redis')
  })

  it('结束面试后归档到历史并清掉 current 文件', () => {
    const before = listSessions().length
    const s = startSession({ company: 'B 公司', role: '前端', round: '二面' })
    addTranscript('讲一下事件循环')
    endSession()

    expect(fs.existsSync(currentFile)).toBe(false)
    expect(listSessions().length).toBe(before + 1)
    expect(listSessions()[0].id).toBe(s.id)
  })

  it('restoreCurrentSession 能恢复上次未结束的会话', () => {
    const payload = {
      id: 'session-restored-1',
      company: 'C 公司',
      role: '算法',
      round: '三面',
      startedAt: Date.now() - 60000,
      transcripts: [{ at: 1, text: '手撕快排', source: 'mixed' }],
      screenshots: [],
      aiAnswers: []
    }
    fs.mkdirSync(path.dirname(currentFile), { recursive: true })
    fs.writeFileSync(currentFile, JSON.stringify(payload), 'utf8')

    const r = restoreCurrentSession()
    expect(r?.id).toBe('session-restored-1')
    expect(r?.transcripts).toHaveLength(1)
  })

  it('restoreCurrentSession 忽略已结束或损坏的残留', () => {
    fs.mkdirSync(path.dirname(currentFile), { recursive: true })
    // 已 endedAt 的不该复活
    fs.writeFileSync(
      currentFile,
      JSON.stringify({ id: 'old', startedAt: 1, endedAt: 2, transcripts: [], screenshots: [], aiAnswers: [] }),
      'utf8'
    )
    expect(restoreCurrentSession()).toBeNull()

    // 半截 JSON 不能直接抛出，要能自愈
    fs.writeFileSync(currentFile, '{"id":"broken", "tru', 'utf8')
    expect(restoreCurrentSession()).toBeNull()
    expect(fs.existsSync(currentFile)).toBe(false)
  })
})

describe('applyRetention 面试历史清理', () => {
  const DAY = 24 * 3600 * 1000

  beforeEach(() => clearAllHistory())

  /** 造一场 n 天前结束的面试并存进历史 */
  function makeOldSession(daysAgo: number, company: string) {
    startSession({ company, role: '后端', round: '一面' })
    endSession()
    const s = listSessions()[0]
    s.startedAt = Date.now() - daysAgo * DAY
    s.endedAt = s.startedAt
  }

  it('清理超过保留天数的面试记录，未过期的不动', () => {
    const originalDays = getSettings().memory.retentionDays
    try {
      makeOldSession(400, 'OldCo')
      makeOldSession(0, 'NewCo')

      saveSettings({
        ...getSettings(),
        memory: { ...getSettings().memory, retentionDays: 30 }
      })
      applyRetention()

      expect(listSessions().map((s) => s.company)).toEqual(['NewCo'])
    } finally {
      saveSettings({ ...getSettings(), memory: { ...getSettings().memory, retentionDays: originalDays } })
    }
  })

  it('记忆库功能关闭时也要清理面试记录（sessions.json 与功能开关无关）', () => {
    const originalMemory = getSettings().memory
    try {
      makeOldSession(400, 'OldCo')

      saveSettings({
        ...getSettings(),
        memory: { ...originalMemory, enabled: false, retentionDays: 30 }
      })
      applyRetention()

      expect(listSessions()).toHaveLength(0)
    } finally {
      saveSettings({ ...getSettings(), memory: originalMemory })
    }
  })
})

/**
 * 「按设备区分说话人」是一个错误抽象，最容易的翻车方式是
 * 把双方的话混成一条流水交给复盘模型 —— 模型只能靠猜归属，
 * myAnswer / weakPoints / mastery 全部会被污染。
 * 这里把正确的映射关系钉死。
 */
describe('说话人角色映射与复盘材料分区', () => {
  it('system 来源 → 标记为面试官（strong）', () => {
    startSession({ company: 'X', role: '后端', round: '一面' })
    addTranscript('请讲一下 JVM 内存结构', 'system')
    const t = currentSessionOrNull()!.transcripts[0]
    expect(t.speaker).toBe('interviewer')
  })

  it('mic 来源 → 标记为我的回答', () => {
    startSession({ company: 'X', role: '后端', round: '一面' })
    addTranscript('堆和栈的区别是……', 'mic')
    expect(currentSessionOrNull()!.transcripts[0].speaker).toBe('candidate')
  })

  it('both 来源 → 标记为 mixed，不硬猜归属', () => {
    startSession({ company: 'X', role: '后端', round: '一面' })
    addTranscript('两个人混在一起的一句', 'both')
    expect(currentSessionOrNull()!.transcripts[0].speaker).toBe('mixed')
  })

  it('复盘材料把面试官与候选人分成不同 section', () => {
    startSession({ company: 'X', role: '后端', round: '一面' })
    addTranscript('请讲一下 JVM 内存结构', 'system')
    addTranscript('JVM 内存分为堆、栈、方法区', 'mic')
    const mat = sessionMaterial(currentSessionOrNull()!)

    expect(mat).toContain('# 面试官提问')
    expect(mat).toContain('# 我的回答')
    // 面试官的话不能出现在「我的回答」section 里
    const candidateSection = mat.split('# 我的回答')[1].split('\n#')[0]
    expect(candidateSection).not.toContain('JVM 内存结构？')
    expect(candidateSection).toContain('堆、栈、方法区')
    // 双方都区分得出来时，不该再生成"未区分角色"那段
    expect(mat).not.toContain('# 未区分角色的转写')
  })

  it('混合来源的转写进入「未区分角色」而不是被算作候选人回答', () => {
    startSession({ company: 'X', role: '后端', round: '一面' })
    addTranscript('混音内容', 'both')
    const mat = sessionMaterial(currentSessionOrNull()!)
    expect(mat).toContain('# 未区分角色的转写')
    expect(mat).not.toContain('# 我的回答')
  })

  it('旧数据没有 speaker 字段时按 source 兜底推断', () => {
    startSession({ company: 'X', role: '后端', round: '一面' })
    const s = currentSessionOrNull()!
    // 模拟历史数据：只有 source，没有 speaker
    s.transcripts.push({ at: Date.now(), text: '旧数据里的面试官提问', source: 'system' })
    s.transcripts.push({ at: Date.now(), text: '旧数据里的我的回答', source: 'mic' })
    const mat = sessionMaterial(s)
    expect(mat).toContain('# 面试官提问')
    expect(mat).toContain('# 我的回答')
    expect(mat).toContain('旧数据里的面试官提问')
  })

  it('AI 参考回答被明确标注为「不是候选人真实说的」', () => {
    startSession({ company: 'X', role: '后端', round: '一面' })
    const s = currentSessionOrNull()!
    s.aiAnswers.push({ at: Date.now(), text: 'AI 生成的参考回答' })
    const mat = sessionMaterial(s)
    expect(mat).toContain('不是候选人真实说出口的回答')
  })
})
