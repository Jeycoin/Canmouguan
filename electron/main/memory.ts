import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { z } from 'zod'
import type { InterviewSession, MasteryLevel, MemoryItem } from '../shared/types'
import { getSettings, getUserDataDir, writeJsonAtomic } from './store'
import { tokenize } from './knowledge'

export const memoryEvents = new EventEmitter()

const MEMORY_FILE = () => path.join(getUserDataDir(), 'memory.json')
const SESSION_FILE = () => path.join(getUserDataDir(), 'sessions.json')
/** 进行中的会话：单独落一份，避免崩溃 / 强退时整场面试材料蒸发 */
const CURRENT_SESSION_FILE = () => path.join(getUserDataDir(), 'session-current.json')
const DAY = 24 * 3600 * 1000

interface Store {
  version: number
  items: MemoryItem[]
}
interface SessionStore {
  version: number
  sessions: InterviewSession[]
}

let cache: Store | null = null
let sessionCache: SessionStore | null = null

// 记忆库倒排索引，避免文本检索时全量扫描
let memoryTokens = new Map<string, Set<string>>() // item id -> tokens
let memoryInverted = new Map<string, Set<string>>() // token -> item ids

/** 读取文件；损坏时把坏文件改名留档后返回兜底值，避免下次启动反复崩在同一个文件上 */
function read<T>(file: string, fallback: T): T {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch (err) {
    console.error('[memory] 读取失败，将备份损坏文件', file, err)
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* noop */
    }
  }
  return fallback
}

function write(file: string, data: unknown) {
  try {
    writeJsonAtomic(file, data)
  } catch (err) {
    console.error('[memory] 写入失败', file, err)
  }
}

function store(): Store {
  if (!cache) {
    cache = read<Store>(MEMORY_FILE(), { version: 1, items: [] })
    indexMemories()
  }
  return cache
}

function persist() {
  write(MEMORY_FILE(), store())
  indexMemories()
  memoryEvents.emit('changed')
}

function sessionStore(): SessionStore {
  if (!sessionCache) sessionCache = read<SessionStore>(SESSION_FILE(), { version: 1, sessions: [] })
  return sessionCache
}

function persistSessions() {
  write(SESSION_FILE(), sessionStore())
}

/* --------------------------------- 会话 --------------------------------- */

let currentSession: InterviewSession | null = null

/**
 * 把进行中的会话落到 session-current.json。
 *
 * 之前 currentSession 只活在内存里，只有点「结束面试」才会进 sessions.json。
 * 结果是：崩溃、强退、系统更新重启 → 整场面试的转写 / 截图 / AI 回答全部清零，
 * 而面试恰恰是最不可能优雅退出的场景。这里改成每次材料变更就落盘。
 */
function persistCurrent(): void {
  try {
    if (currentSession) write(CURRENT_SESSION_FILE(), currentSession)
    else if (fs.existsSync(CURRENT_SESSION_FILE())) fs.unlinkSync(CURRENT_SESSION_FILE())
  } catch (err) {
    console.error('[memory] 保存当前会话失败', err)
  }
}

/**
 * 启动时恢复上次未结束的会话（崩溃遗留）。
 * 与会话列表里的历史项不同，这份是"还没复盘过"的，恢复后用户可以直接结束并复盘。
 */
export function restoreCurrentSession(): InterviewSession | null {
  if (currentSession) return currentSession
  const raw = read<InterviewSession | null>(CURRENT_SESSION_FILE(), null)
  if (!raw || typeof raw !== 'object') return null
  if (!raw.id || typeof raw.startedAt !== 'number' || raw.endedAt) return null
  currentSession = {
    ...raw,
    transcripts: Array.isArray(raw.transcripts) ? raw.transcripts : [],
    screenshots: Array.isArray(raw.screenshots) ? raw.screenshots : [],
    aiAnswers: Array.isArray(raw.aiAnswers) ? raw.aiAnswers : []
  }
  memoryEvents.emit('session', currentSession)
  return currentSession
}

export function startSession(meta: { company: string; role: string; round: string }): InterviewSession {
  currentSession = {
    id: randomUUID(),
    company: meta.company,
    role: meta.role,
    round: meta.round,
    startedAt: Date.now(),
    transcripts: [],
    screenshots: [],
    aiAnswers: []
  }
  persistCurrent()
  memoryEvents.emit('session', currentSession)
  return currentSession
}

export function currentSessionOrNull(): InterviewSession | null {
  return currentSession
}

/**
 * 记录一条转写。
 *
 * `audioSource` 是**采集来源**（mic / system / both），`speaker` 是**说话人角色**。
 * 两者不是一回事，但可以可靠地互相推导 —— 这正是避免"用设备去区分说话人"这个错误抽象的关键：
 *
 * - `system`（系统回环）：收到的一定是**面试官**的声音，候选人自己的声音不会进回环。
 * - `mic`（纯麦克风）：拾到的是**候选人自己**的声音（外放时可能串入面试官，故记为 weak）。
 * - `both`（两路混音）：信号层已经混在一起，**无法**靠这个维度区分 → mixed，
 *   真正的区分要靠模型层的说话人分离（diarization）。
 *
 * 注意 both 情况下我选 mixed 而不是按时间猜：猜错会把面试官的问题标成我的回答，
 * 直接污染后续复盘的「myAnswer / weakPoints」判定，比不标更糟。
 */
function speakerFromSource(
  audioSource: string
): { speaker: 'interviewer' | 'candidate' | 'mixed'; confidence: 'strong' | 'weak' } {
  if (audioSource === 'system') return { speaker: 'interviewer', confidence: 'strong' }
  if (audioSource === 'mic') return { speaker: 'candidate', confidence: 'weak' }
  return { speaker: 'mixed', confidence: 'weak' }
}

export function addTranscript(text: string, source = 'mixed') {
  if (!currentSession || !text.trim()) return
  if (!getSettings().privacy.persistTranscript) return
  const { speaker } = speakerFromSource(source)
  currentSession.transcripts.push({ at: Date.now(), text: text.trim(), source, speaker })
  persistCurrent()
}

export function addScreenshot(note?: string) {
  if (!currentSession) return
  currentSession.screenshots.push({ at: Date.now(), note })
  persistCurrent()
}

export function addAiAnswer(text: string) {
  if (!currentSession || !text.trim()) return
  currentSession.aiAnswers.push({ at: Date.now(), text: text.trim() })
  persistCurrent()
}

export function endSession(): InterviewSession | null {
  if (!currentSession) return null
  currentSession.endedAt = Date.now()
  const s = sessionStore()
  s.sessions.unshift(currentSession)
  sessionCache = s
  persistSessions()
  const done = currentSession
  currentSession = null
  persistCurrent()
  memoryEvents.emit('session', null)
  return done
}

/** 进行中就把一场面试归档进历史（退出兜底用），没有进行中会话则返回 null */
export function archiveCurrentSession(): InterviewSession | null {
  return currentSession ? endSession() : null
}

export function clearAllHistory(): void {
  clearMemories()
  // 历史会话、进行中的会话、导出留档一并清除
  sessionCache = { version: 1, sessions: [] }
  currentSession = null
  persistSessions()
  persistCurrent()
  try {
    const dir = path.join(getUserDataDir(), 'captures')
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    console.error('[memory] 清除截图缓存失败', err)
  }
  memoryEvents.emit('session', null)
}

export function listSessions(): InterviewSession[] {
  return sessionStore().sessions
}

export function getSession(id: string): InterviewSession | undefined {
  return sessionStore().sessions.find((s) => s.id === id)
}

export function deleteSession(id: string) {
  const s = sessionStore()
  s.sessions = s.sessions.filter((x) => x.id !== id)
  sessionCache = s
  persistSessions()
}

/**
 * 把一场面试的材料整理成复盘用的文本。
 *
 * **关键点：转写必须按说话人角色分开呈现，不能混成一条流水。**
 * 复盘的核心任务是「面试官问了什么 → 我答得怎么样 → 该怎么答」，
 * 而 `myAnswer` / `weakPoints` / `mastery` 全部依赖"哪句是我说的"。
 * 旧的实现把双方的话统一渲染成 `- 文本`，模型必须靠猜来归属，
 * 结果是候选人说出的话容易被当成面试官的提问，或反过来 —— 整个复盘的准确性都被拖垮。
 *
 * 现在按 speaker 分成 「面试官提问」/「我的回答」两个 section；
 * 分不出来的（both 混音、无 speaker 的旧数据）单独放「未区分角色的转写」，
 * 并明确告诉模型不要硬猜归属。
 */
export function sessionMaterial(s: InterviewSession, maxChars = 12000): string {
  const parts: string[] = []
  parts.push(`# 面试信息\n公司：${s.company}\n岗位：${s.role}\n轮次：${s.round}\n时长：${Math.round(((s.endedAt ?? Date.now()) - s.startedAt) / 60000)} 分钟`)

  if (s.transcripts.length) {
    const interviewer: string[] = []
    const candidate: string[] = []
    const unknown: string[] = []
    for (const t of s.transcripts) {
      // 旧数据没有 speaker 字段；audioSource 也只有 mic/system/both，
      // 因此按"来源"兜底推断一次（见 speakerFromSource 的注释）。
      const speaker = t.speaker ?? (t.source === 'system' ? 'interviewer' : t.source === 'mic' ? 'candidate' : 'mixed')
      if (speaker === 'interviewer') interviewer.push(t.text)
      else if (speaker === 'candidate') candidate.push(t.text)
      else unknown.push(t.text)
    }

    if (interviewer.length) {
      parts.push('# 面试官提问（这是「对方」说的话，复盘时作为 question 的来源）\n' + interviewer.map((t, i) => `Q${i + 1}. ${t}`).join('\n'))
    }
    if (candidate.length) {
      parts.push('# 我的回答（这是「候选人本人」说的话，复盘时作为 myAnswer 的来源）\n' + candidate.map((t, i) => `A${i + 1}. ${t}`).join('\n'))
    }
    if (unknown.length) {
      parts.push(
        '# 未区分角色的转写\n' +
          '以下是单路混音（麦克风 + 系统声音）采集到的内容，双方的话混在一起、顺序也未必准确。\n' +
          '**请只把它当作背景参考，不要仅凭它断定某句话是谁说的**；' +
          '若因此无法确定 myAnswer 归属，就把 myAnswer 留空、并在 weakPoints 里说明"未能区分双方发言"。\n' +
          unknown.map((t) => `- ${t}`).join('\n')
      )
    }
  }

  if (s.screenshots.length) {
    parts.push(`# 截图分析\n共 ${s.screenshots.length} 次截图` + (s.screenshots[0]?.note ? `\n${s.screenshots[0].note}` : ''))
  }
  if (s.aiAnswers.length) {
    parts.push(
      '# AI 当时给出的参考回答\n' +
        '注意：这是辅助工具生成的**参考**答案，不是候选人真实说出口的回答。' +
        '判定 mastery / myAnswer 时以「我的回答」section 为准，这里只用于对照标准答案。\n' +
        s.aiAnswers.map((t) => `- ${t}`).join('\n')
    )
  }
  const all = parts.join('\n\n')
  return all.length > maxChars ? all.slice(0, maxChars) + '\n…（已截断）' : all
}

/* -------------------------------- 记忆条目 ------------------------------- */

function nextReviewAt(stage: number): number {
  const intervals = getSettings().memory.reviewIntervals
  const days = intervals[Math.min(stage, intervals.length - 1)] ?? 1
  return Date.now() + days * DAY
}

export function listMemories(): MemoryItem[] {
  return [...store().items].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function addMemory(input: Partial<MemoryItem>): MemoryItem {
  const now = Date.now()
  const item: MemoryItem = {
    id: randomUUID(),
    question: input.question ?? '',
    knowledgePoints: input.knowledgePoints ?? [],
    referenceAnswer: input.referenceAnswer ?? '',
    myAnswer: input.myAnswer ?? '',
    weakPoints: input.weakPoints ?? [],
    suggestions: input.suggestions ?? '',
    tags: input.tags ?? [],
    mastery: clampMastery(input.mastery ?? 2),
    source: input.source ?? { company: '', role: '', round: '', at: now, sessionId: '' },
    createdAt: now,
    updatedAt: now,
    nextReviewAt: nextReviewAt(0),
    reviewStage: 0,
    reviewCount: 0
  }
  store().items.unshift(item)
  persist()
  return item
}

export function updateMemory(id: string, patch: Partial<MemoryItem>): MemoryItem | null {
  const item = store().items.find((x) => x.id === id)
  if (!item) return null
  Object.assign(item, patch, { updatedAt: Date.now() })
  if (patch.mastery !== undefined) item.mastery = clampMastery(patch.mastery)
  persist()
  return item
}

export function deleteMemory(id: string) {
  const s = store()
  s.items = s.items.filter((x) => x.id !== id)
  persist()
}

export function clearMemories() {
  cache = { version: 1, items: [] }
  persist()
}

function clampMastery(v: number): MasteryLevel {
  const n = Math.round(Number(v) || 0)
  return Math.max(0, Math.min(5, n)) as MasteryLevel
}

/* --------------------------------- 检索 --------------------------------- */

function indexMemories() {
  memoryTokens = new Map()
  memoryInverted = new Map()
  for (const m of store().items) {
    const tokens = tokenize(
      `${m.question} ${m.knowledgePoints.join(' ')} ${m.tags.join(' ')} ${m.referenceAnswer} ${m.weakPoints.join(' ')}`
    )
    memoryTokens.set(m.id, new Set(tokens))
    for (const t of tokens) {
      if (!memoryInverted.has(t)) memoryInverted.set(t, new Set())
      memoryInverted.get(t)!.add(m.id)
    }
  }
}

export interface MemoryQuery {
  text?: string
  tags?: string[]
  company?: string
  knowledgePoint?: string
  topK?: number
  maxMastery?: number
}

export function searchMemories(q: MemoryQuery): MemoryItem[] {
  const settings = getSettings()
  const topK = q.topK ?? settings.memory.retrievalTopK ?? 5
  let pool = listMemories()

  if (q.company) {
    const c = q.company.toLowerCase()
    pool = pool.filter((m) => m.source.company.toLowerCase().includes(c))
  }
  if (q.knowledgePoint) {
    const k = q.knowledgePoint.toLowerCase()
    pool = pool.filter((m) => m.knowledgePoints.some((p) => p.toLowerCase().includes(k)))
  }
  if (q.tags?.length) {
    pool = pool.filter((m) => q.tags!.some((t) => m.tags.some((x) => x.toLowerCase().includes(t.toLowerCase()))))
  }
  if (q.maxMastery !== undefined) {
    pool = pool.filter((m) => m.mastery <= q.maxMastery!)
  }

  if (!q.text?.trim()) return pool.slice(0, topK)

  const qTokens = tokenize(q.text)

  // 用倒排索引快速得到候选条目
  const candidateIds = new Set<string>()
  for (const t of qTokens) {
    memoryInverted.get(t)?.forEach((id) => candidateIds.add(id))
  }
  if (!candidateIds.size) return []

  // 倒排索引与 items 理论上同步重建，但一旦不一致（例如外部改过文件）
  // 这里会直接崩在一次普通检索上，因此按 miss 处理而不是强断言
  const scored = pool
    .filter((m) => candidateIds.has(m.id) && memoryTokens.has(m.id))
    .map((m) => {
      const mt = memoryTokens.get(m.id) ?? new Set<string>()
      let score = 0
      for (const t of qTokens) if (mt.has(t)) score += 1
      // 薄弱项优先：掌握程度低的更应该被想起
      score += (5 - m.mastery) * 0.15
      return { m, score }
    })
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.m)
}

/** 把记忆渲染成可注入提示词的文本 */
export function renderMemories(items: MemoryItem[]): string {
  if (!items.length) return '（暂无历史记忆）'
  return items
    .map(
      (m, i) =>
        `${i + 1}. 【${m.source.company || '未知'}·${m.source.round || '-'}】${m.question}\n` +
        `   知识点：${m.knowledgePoints.join('、') || '-'}\n` +
        `   参考思路：${m.referenceAnswer.slice(0, 220)}\n` +
        `   曾经的问题：${m.weakPoints.join('、') || '无'}\n` +
        `   掌握程度：${m.mastery}/5`
    )
    .join('\n')
}

/* -------------------------------- 复习卡片 ------------------------------- */

export function dueCards(limit = 20): MemoryItem[] {
  if (!getSettings().memory.enabled) return []
  const now = Date.now()
  return listMemories()
    .filter((m) => m.nextReviewAt <= now)
    .sort((a, b) => a.nextReviewAt - b.nextReviewAt)
    .slice(0, limit)
}

export function reviewCard(id: string, result: 'mastered' | 'fuzzy' | 'unknown'): MemoryItem | null {
  const item = store().items.find((x) => x.id === id)
  if (!item) return null
  item.reviewCount += 1
  item.lastReviewResult = result
  if (result === 'mastered') {
    item.reviewStage += 1
    item.mastery = clampMastery(item.mastery + 1)
  } else if (result === 'fuzzy') {
    item.reviewStage = Math.max(0, item.reviewStage)
    item.mastery = clampMastery(Math.max(1, item.mastery))
  } else {
    item.reviewStage = 0
    item.mastery = clampMastery(0)
  }
  item.nextReviewAt = nextReviewAt(item.reviewStage)
  item.updatedAt = Date.now()
  persist()
  return item
}

/* ------------------------------ 导入 / 导出 ------------------------------ */

export function exportMemories(): string {
  return JSON.stringify({ version: 1, exportedAt: Date.now(), items: listMemories() }, null, 2)
}

const memoryItemSchema = z.object({
  question: z.string().min(1),
  knowledgePoints: z.array(z.string()).default([]),
  referenceAnswer: z.string().default(''),
  myAnswer: z.string().default(''),
  weakPoints: z.array(z.string()).default([]),
  suggestions: z.string().default(''),
  tags: z.array(z.string()).default([]),
  mastery: z.number().int().min(0).max(5).default(2),
  source: z
    .object({
      company: z.string().default(''),
      role: z.string().default(''),
      round: z.string().default(''),
      at: z.number().default(() => Date.now()),
      sessionId: z.string().default('')
    })
    .default(() => ({ company: '', role: '', round: '', at: Date.now(), sessionId: '' }))
})

const importSchema = z.union([
  z.object({ version: z.number().optional(), items: z.array(memoryItemSchema) }),
  z.array(memoryItemSchema)
])

export function importMemories(json: string, mode: 'merge' | 'replace' = 'merge'): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new Error('导入文件不是有效 JSON')
  }
  const validated = importSchema.safeParse(parsed)
  if (!validated.success) {
    throw new Error(`记忆库格式校验失败：${validated.error.issues[0]?.message ?? '未知错误'}`)
  }
  const incoming = Array.isArray(validated.data) ? validated.data : validated.data.items
  if (!incoming.length) throw new Error('文件中没有可导入的记忆条目')

  const s = store()
  if (mode === 'replace') s.items = []

  // 合并：按 question 去重，保留更完整的那条
  let added = 0
  for (const raw of incoming) {
    if (!raw?.question) continue
    const existIdx = s.items.findIndex((x) => x.question.trim() === raw.question!.trim())
    if (existIdx >= 0) {
      const exist = s.items[existIdx]
      const merged: MemoryItem = {
        ...exist,
        question: raw.question,
        knowledgePoints: raw.knowledgePoints,
        referenceAnswer: raw.referenceAnswer,
        myAnswer: raw.myAnswer,
        weakPoints: raw.weakPoints,
        suggestions: raw.suggestions,
        tags: raw.tags,
        mastery: clampMastery(raw.mastery),
        source: raw.source as MemoryItem['source'],
        id: exist.id,
        createdAt: exist.createdAt,
        updatedAt: Date.now(),
        nextReviewAt: exist.nextReviewAt,
        reviewStage: exist.reviewStage,
        reviewCount: exist.reviewCount,
        lastReviewResult: exist.lastReviewResult
      }
      s.items[existIdx] = merged
    } else {
      s.items.unshift({
        id: randomUUID(),
        question: raw.question,
        knowledgePoints: raw.knowledgePoints ?? [],
        referenceAnswer: raw.referenceAnswer ?? '',
        myAnswer: raw.myAnswer ?? '',
        weakPoints: raw.weakPoints ?? [],
        suggestions: raw.suggestions ?? '',
        tags: raw.tags ?? [],
        mastery: clampMastery(raw.mastery),
        source: raw.source as MemoryItem['source'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        nextReviewAt: nextReviewAt(0),
        reviewStage: 0,
        reviewCount: 0
      })
      added++
    }
  }
  persist()
  return added
}

export function exportMemoriesMarkdown(): string {
  const items = listMemories()
  const lines: string[] = ['# 面试记忆库导出', '', `> 导出时间：${new Date().toLocaleString()}　共 ${items.length} 条`, '']
  for (const m of items) {
    lines.push(`## ${m.question}`)
    lines.push('')
    lines.push(`- 来源：${m.source.company || '-'} / ${m.source.role || '-'} / ${m.source.round || '-'} / ${new Date(m.source.at).toLocaleDateString()}`)
    lines.push(`- 知识点：${m.knowledgePoints.join('、') || '-'}`)
    lines.push(`- 标签：${m.tags.join('、') || '-'}`)
    lines.push(`- 掌握程度：${m.mastery}/5　复习次数：${m.reviewCount}`)
    lines.push('')
    if (m.referenceAnswer) lines.push(`**参考思路**：${m.referenceAnswer}`, '')
    if (m.myAnswer) lines.push(`**我的回答**：${m.myAnswer}`, '')
    if (m.weakPoints.length) lines.push(`**薄弱点**：${m.weakPoints.join('、')}`, '')
    if (m.suggestions) lines.push(`**改进建议**：${m.suggestions}`, '')
    lines.push('---', '')
  }
  return lines.join('\n')
}

/* ------------------------------ 保留策略清理 ------------------------------ */

/**
 * 按用户的「保留天数」清理过期数据。
 *
 * 面试历史（sessions.json）原来**完全没有上限**：每场面试都把全部转写、截图索引、
 * AI 回答 `unshift` 进去，只有用户手动删单条才会减少。重度使用下这个文件会持续膨胀，
 * 而它每次启动都要整份读进内存解析（`sessionStore()`），首屏会越来越慢。
 * 既然用户已经设了「保留天数」，就让它同时作用于面试记录 —— 这才是这个设置该有的语义。
 *
 * 注意：会话清理放在 `memory.enabled` 判断**之外**。面试记录是独立的数据文件，
 * 和"记忆库"这个功能开关无关；否则关掉记忆库就等于让 sessions.json 无限增长。
 */
export function applyRetention() {
  const s = getSettings()
  const days = Math.max(1, s.memory.retentionDays)
  const cutoff = Date.now() - days * DAY

  // 1) 过期的面试记录
  const ss = sessionStore()
  const sBefore = ss.sessions.length
  ss.sessions = ss.sessions.filter((x) => (x.endedAt ?? x.startedAt ?? 0) >= cutoff)
  if (ss.sessions.length !== sBefore) {
    console.log(`[memory] 保留策略清理了 ${sBefore - ss.sessions.length} 场过期面试记录（超过 ${days} 天）`)
    persistSessions()
  }

  // 2) 过期的记忆条目
  if (!s.memory.enabled) return
  const st = store()
  const before = st.items.length
  st.items = st.items.filter((m) => m.updatedAt >= cutoff)
  if (st.items.length !== before) persist()
}

/* -------------------------------- 统计 --------------------------------- */

export function memoryStats() {
  const items = listMemories()
  const byMastery = [0, 0, 0, 0, 0, 0]
  for (const m of items) byMastery[m.mastery]++
  const tags = new Map<string, number>()
  for (const m of items) for (const t of m.tags) tags.set(t, (tags.get(t) ?? 0) + 1)
  const kp = new Map<string, number>()
  for (const m of items) for (const k of m.knowledgePoints) kp.set(k, (kp.get(k) ?? 0) + 1)
  return {
    total: items.length,
    byMastery,
    due: dueCards(1000).length,
    topTags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    topKnowledgePoints: [...kp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  }
}
