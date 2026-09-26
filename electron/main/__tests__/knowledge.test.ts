import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { tokenize, searchKnowledge, loadKnowledge } from '../knowledge'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((name: string) => path.join('/tmp/interview-copilot-test', name)) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain),
    decryptString: (buf: Buffer) => buf.toString()
  }
}))

describe('tokenize', () => {
  it('切分中文二元组与英文单词', () => {
    const tokens = tokenize('TCP 三次握手与 Redis 持久化')
    expect(tokens).toContain('tcp')
    expect(tokens).toContain('三次')
    expect(tokens).toContain('握手')
    expect(tokens).toContain('redis')
    // 中文按二元组切分
    expect(tokens).toContain('持久')
    expect(tokens).toContain('久化')
  })

  it('过滤停用词', () => {
    const tokens = tokenize('什么是 Redis 的持久化')
    expect(tokens).not.toContain('什么')
    expect(tokens).not.toContain('是')
    expect(tokens).not.toContain('的')
  })
})

describe('searchKnowledge', () => {
  const dir = path.join('/tmp/interview-copilot-test', 'kb-search')

  beforeEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('按标题与内容命中文档', () => {
    fs.writeFileSync(
      path.join(dir, 'redis.md'),
      '---\ntitle: Redis\ncategory: 技术八股\ntags: [cache]\n---\n\nRedis 持久化有 RDB 和 AOF 两种机制。',
      'utf8'
    )
    loadKnowledge(dir)
    const hits = searchKnowledge('Redis 持久化', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].doc.title).toBe('Redis')
  })

  it('未命中时返回空数组', () => {
    loadKnowledge(dir)
    expect(searchKnowledge('qqqzzz', 5)).toEqual([])
    expect(searchKnowledge('', 5)).toEqual([])
  })

  it('同一目录下长文件名的文档 id 必须互不相同', () => {
    // 回归：早期版本把 base64(path) 截断到前 32 字符，同目录长路径会撞车，
    // 导致 kb:get / kb:save 实际操作到了另一篇文档。
    const names = [
      '2026-后端工程师-分布式系统-高可用架构设计-面试准备笔记-v1.md',
      '2026-后端工程师-分布式系统-高可用架构设计-面试准备笔记-v2.md',
      '2026-后端工程师-分布式系统-高可用架构设计-面试准备笔记-v3.md'
    ]
    for (const n of names) {
      fs.writeFileSync(path.join(dir, n), `---\ntitle: ${n}\n---\n\n内容-${n}`, 'utf8')
    }
    // loadKnowledge 会顺带 ensureKnowledgeDir 生成 6 篇示例 MD，这里只考察自己写的三篇
    const mine = loadKnowledge(dir).filter((d) => path.basename(d.path).startsWith('2026-'))
    expect(mine).toHaveLength(3)
    const ids = new Set(mine.map((d) => d.id))
    expect(ids.size).toBe(3)
  })
})
