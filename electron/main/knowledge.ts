import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import { EventEmitter } from 'node:events'
import type { KnowledgeDoc, KnowledgeHit } from '../shared/types'
import { getSettings } from './store'

export const knowledgeEvents = new EventEmitter()

let docs: Map<string, KnowledgeDoc> = new Map()
let watcher: FSWatcher | null = null

// 倒排索引，避免每次检索都全量扫描文档内容
let docTokens = new Map<string, Set<string>>() // path -> tokens
let titleTokens = new Map<string, Set<string>>() // path -> title tokens
let tagTokens = new Map<string, Set<string>>() // path -> lowercased tags
let inverted = new Map<string, Set<string>>() // token -> paths

export const KNOWLEDGE_CATEGORIES = [
  { id: 'intro', name: '自我介绍', file: '01-自我介绍.md' },
  { id: 'project', name: '项目经历', file: '02-项目经历.md' },
  { id: 'tech', name: '技术八股', file: '03-技术八股.md' },
  { id: 'algorithm', name: '算法题', file: '04-算法题.md' },
  { id: 'behavior', name: '行为面试 STAR', file: '05-行为面试.md' },
  { id: 'askback', name: '反问面试官', file: '06-反问面试官.md' }
]

const SAMPLE_DOCS: Record<string, string> = {
  '01-自我介绍.md': `---
title: 自我介绍
category: 自我介绍
tags: [自我介绍, 通用]
updated: 2026-01-01
---

## 30 秒版本（最常用，背熟）

面试官您好，我是 {{name}}，{{years}} 年后端/全栈开发经验。
最近一份工作在 {{company}} 负责 {{domain}} 方向，核心成绩是 {{highlight}}。
技术栈上我比较熟悉 {{stack}}，对 {{strength}} 这块有比较深的理解。
今天很期待和您交流 {{role}} 这个岗位。

## 90 秒版本（技术岗 / 需要展开项目）

1. **我是谁**：{{name}}，{{years}} 年经验，{{school}} 毕业。
2. **我做过什么**：在 {{company}} 主导了 {{project}}，解决了 {{problem}}，最终 {{result}}。
3. **我为什么匹配**：注意到贵岗位 JD 里强调 {{jdKeyword}}，这正好是我上一阶段的主要工作。
4. **收尾**：以上是我的基本情况，您想先聊项目还是技术细节？

## 使用提醒

- 开头不要说"我叫 XX，来自 XX，很高兴参加面试"这种流水账，直接进入价值点。
- 全程 {{seconds}} 秒内，超时会被打断。
- 每个数字都要真实，面试官会追问。
`,
  '02-项目经历.md': `---
title: 项目经历
category: 项目经历
tags: [项目, STAR, 亮点]
updated: 2026-01-01
---

## 项目一：{{projectName}}

**背景（Situation）**：{{background}}
**任务（Task）**：我负责 {{myTask}}
**行动（Action）**：
1. {{action1}}
2. {{action2}}
3. {{action3}}
**结果（Result）**：{{result}}（量化：QPS / RT / 成本 / 人效）

### 必背追问
- 为什么选这个方案而不是 XX？→ 对比表 + 取舍理由
- 最大的技术难点是什么？→ 只讲一个，讲透
- 如果重做你会改哪里？→ 给 2 条真实反思

## 项目二：{{projectName2}}

> 复制上面的结构填充。

## 项目讲述的通用原则

- 用"问题 → 约束 → 决策 → 结果"四段式，别按时间流水账讲。
- 每个项目准备 3 个"坑"，面试官 80% 会追问。
- 数字必须能被追问：口径、统计周期、对比基线都要能答。
`,
  '03-技术八股.md': `---
title: 技术八股
category: 技术八股
tags: [八股, 原理, 高频]
updated: 2026-01-01
---

## 高频清单（按命中率排序）

1. TCP 三次握手 / 四次挥手，TIME_WAIT 的作用
2. 进程 / 线程 / 协程的区别与调度
3. 索引失效场景、最左前缀、回表
4. 事务隔离级别与 MVCC 实现
5. 缓存穿透 / 击穿 / 雪崩及对应解法
6. GC 算法：标记清除 / 复制 / 标记整理，分代回收
7. 线程池参数与拒绝策略
8. 分布式锁：Redis vs Zookeeper，Redlock 争议
9. CAP 与 BASE，一致性协议 Raft
10. 消息队列：如何保证不丢、不重、有序

## 答题模板

> **定义 → 为什么需要 → 怎么做 → 边界/代价 → 我踩过的坑**

## 你自己的补充区

- 知识点：
- 一句话答案：
- 深入追问：
`,
  '04-算法题.md': `---
title: 算法题
category: 算法题
tags: [算法, 套路]
updated: 2026-01-01
---

## 通用解题流程（说出来，面试官会加分）

1. **复述题意 + 确认边界**：输入输出规模、是否允许修改原数组、是否有重复元素。
2. **举 2 个例子**，包括一个边界例子。
3. **先给暴力解**，分析复杂度，再优化。
4. **写代码**，边写边说变量含义。
5. **手动跑一遍**例子。
6. **复杂度 + 能否再优化**。

## 套路速查

| 题型 | 典型方法 |
| --- | --- |
| 区间 / 连续子数组 | 滑动窗口、前缀和 |
| 有序、查找 | 二分（注意边界写法） |
| 树 | 递归 / 层序 /  Morris |
| 图 | BFS / DFS / 拓扑 / 并查集 |
| 最值 + 可行性 | 二分答案 |
| 计数 / 频次 | 哈希表、桶 |
| 最优子结构 | 动态规划（先写状态定义） |

## 错题本

- 题目：
- 卡在哪一步：
- 正确思路：
`,
  '05-行为面试.md': `---
title: 行为面试 STAR
category: 行为面试
tags: [行为面试, STAR, 软技能]
updated: 2026-01-01
---

## STAR 模板

- **S 情境**：一句话交代背景和时间（控制在 2 句内）
- **T 任务**：我要解决的具体问题 / 我承担的职责
- **A 行动**：我做了什么（用"我"不用"我们"，写 3 步）
- **R 结果**：量化结果 + 沉淀（文档 / 规范 / 工具）

## 高频问题与骨架

### 最有成就感的事
→ 选一个"有明确数字 + 有技术难度 + 有影响面"的项目。

### 和同事发生冲突
→ 不要说对方错。说"目标不一致 → 我主动对齐 → 用数据说服 → 达成共识"。

### 最有挑战的技术问题
→ 用"现象 → 排查路径 → 根因 → 解决 → 防复发"五段式。

### 你的缺点
→ 真实但不致命 + 正在改进的具体动作。（例：过早优化 → 现在先做衡量再做优化）

### 为什么离职 / 为什么来我们公司
→ 只讲"我想要什么"，不讲"前东家不好"。

## 反问面试官（一定要准备 2-3 个）

1. 这个岗位所在的团队目前最想解决的技术问题是什么？
2. 您觉得这个岗位做得好的人，半年后和刚入职时最大的差别是什么？
3. 团队现在的技术栈和工程流程是怎样的？迭代周期多长？
`,
  '06-反问面试官.md': `---
title: 反问面试官
category: 反问
tags: [反问, 收尾]
updated: 2026-01-01
---

## 通用高分反问

1. **团队与业务**：这个岗位所在的团队目前最想解决的技术问题是什么？
2. **成长预期**：您觉得做得好的人，半年后和刚入职时最大的差别是什么？
3. **工程现状**：团队的技术栈、代码评审和发布流程是怎样的？
4. **协作方式**：这个岗位日常会和哪些团队打交道？
5. **下一步**：后面还有几轮面试，主要考察什么方向？

## 分轮次选择

- **一面（技术）**：问技术栈、工程流程、技术债怎么处理。
- **二面（主管）**：问团队目标、优先级怎么定、对个人成长的期待。
- **三面（总监/HR）**：问业务战略、组织架构、晋升与培养机制。

## 不要问

- 薪资、加班费、年假（留给 HR 环节）
- 网上能查到的公司基本信息
- "我今天表现怎么样"（把评价权交给对方前先别主动要评价）
`
}

export function ensureKnowledgeDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(SAMPLE_DOCS)) {
    const p = path.join(dir, file)
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, content, 'utf8')
    }
  }
}

function parseFile(file: string): KnowledgeDoc | null {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = matter(raw)
    const stat = fs.statSync(file)
    const data = parsed.data as Record<string, unknown>
    const name = path.basename(file, '.md')
    return {
      // 不再截断到 32 字符：base64(path) 前 32 位只覆盖路径的前 24 个字节，
      // 同目录下长文件名的文档会算出同一个 id，导致 kb:get / kb:save 打到错的文档上。
      id: Buffer.from(file).toString('base64url'),
      path: file,
      title: typeof data.title === 'string' && data.title ? data.title : name,
      category: typeof data.category === 'string' && data.category ? data.category : inferCategory(name),
      tags: Array.isArray(data.tags) ? (data.tags as string[]).map(String) : [],
      content: parsed.content,
      updatedAt: stat.mtimeMs,
      size: stat.size
    }
  } catch (err) {
    console.error('[knowledge] 解析失败', file, err)
    return null
  }
}

function inferCategory(name: string): string {
  if (name.includes('介绍')) return '自我介绍'
  if (name.includes('项目')) return '项目经历'
  if (name.includes('八股') || name.includes('技术')) return '技术八股'
  if (name.includes('算法') || name.includes('题')) return '算法题'
  if (name.includes('行为') || name.includes('STAR')) return '行为面试'
  if (name.includes('反问')) return '反问面试官'
  return '未分类'
}

export function loadKnowledge(dir?: string): KnowledgeDoc[] {
  const target = dir || getSettings().knowledgeDir
  if (!target) return []
  ensureKnowledgeDir(target)
  const next = new Map<string, KnowledgeDoc>()
  const walk = (d: string) => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch (err) {
   console.error('[knowledge] 忽略异常', err)
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue
        walk(full)
      } else if (/\.(md|markdown)$/i.test(e.name)) {
        const doc = parseFile(full)
        if (doc) next.set(full, doc)
      }
    }
  }
  walk(target)
  docs = next
  buildIndex()
  knowledgeEvents.emit('reloaded', listKnowledge())
  return listKnowledge()
}

function buildIndex() {
  docTokens = new Map()
  titleTokens = new Map()
  tagTokens = new Map()
  inverted = new Map()
  for (const doc of docs.values()) {
    const all = tokenize(`${doc.title}\n${doc.tags.join(' ')}\n${doc.category}\n${doc.content}`)
    const title = tokenize(doc.title)
    const tags = new Set(doc.tags.map((t) => t.toLowerCase()))
    docTokens.set(doc.path, new Set(all))
    titleTokens.set(doc.path, new Set(title))
    tagTokens.set(doc.path, tags)
    for (const t of all) {
      if (!inverted.has(t)) inverted.set(t, new Set())
      inverted.get(t)!.add(doc.path)
    }
  }
}

export function listKnowledge(): KnowledgeDoc[] {
  return [...docs.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export function watchKnowledge(dir: string) {
  closeKnowledgeWatcher()
  if (!dir) return
  ensureKnowledgeDir(dir)
  watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    depth: 4,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
  })
  const reload = (p: string) => {
    if (!/\.(md|markdown)$/i.test(p)) return
    loadKnowledge(dir)
  }
  watcher.on('add', reload).on('change', reload).on('unlink', reload)
  // 必须挂 error 监听：EventEmitter 的 'error' 事件没有监听者会直接抛异常，
  // 监听目录被删除 / 权限不足时会让整个主进程崩掉。
  watcher.on('error', (err) => {
    console.error('[knowledge] 监听目录出错', err)
  })
}

/** 退出前关闭监听（否则退出后目录句柄不释放，Windows 上会挡住用户重命名/删除该目录） */
export function closeKnowledgeWatcher() {
  if (watcher) {
    void watcher.close()
    watcher = null
  }
}

export function getDoc(id: string): KnowledgeDoc | undefined {
  return listKnowledge().find((d) => d.id === id)
}

export function saveDoc(id: string, content: string): boolean {
  const doc = getDoc(id)
  if (!doc) return false
  fs.writeFileSync(doc.path, content, 'utf8')
  loadKnowledge()
  return true
}

export function createDoc(name: string, category: string, content = '## 新文档\n\n'): KnowledgeDoc | null {
  const dir = getSettings().knowledgeDir
  if (!dir) return null
  ensureKnowledgeDir(dir)
  const safe = name.replace(/[\\/:*?"<>|]/g, '_')
  const file = path.join(dir, safe.endsWith('.md') ? safe : safe + '.md')
  if (fs.existsSync(file)) return null
  fs.writeFileSync(file, `---\ntitle: ${safe.replace(/\.md$/, '')}\ncategory: ${category}\ntags: []\n---\n\n${content}`, 'utf8')
  loadKnowledge()
  return listKnowledge().find((d) => d.path === file) ?? null
}

export function deleteDoc(id: string): boolean {
  const doc = getDoc(id)
  if (!doc) return false
  try {
    fs.unlinkSync(doc.path)
    loadKnowledge()
    return true
  } catch (err) {
   console.error('[knowledge] 忽略异常', err)
    return false
  }
}

/* ------------------------------- 关键词检索 ------------------------------- */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'with',
  '的', '了', '是', '在', '和', '与', '就', '都', '而', '及', '这', '那', '有', '我', '你', '他', '什么',
  '怎么', '如何', '为什么', '请', '可以', '吗', '呢', '吧', '一个', '我们'
])

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  // 英文/数字词
  const en = lower.match(/[a-z][a-z0-9+#._-]{1,}|[0-9]+/g) ?? []
  tokens.push(...en)
  // 中文：二元切分（简单有效，无需分词库）
  const zh = lower.match(/[\u4e00-\u9fa5]+/g) ?? []
  for (const seg of zh) {
    if (seg.length === 1) tokens.push(seg)
    for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2))
  }
  return tokens.filter((t) => !STOPWORDS.has(t))
}

/**
 * 关键词检索：BM25 简化版打分。
 * 后续可升级为向量 RAG，接口保持 search() 不变即可。
 */
export function searchKnowledge(query: string, topK = 5, category?: string): KnowledgeHit[] {
  const qTokens = tokenize(query)
  if (!qTokens.length) return []

  // 用倒排索引快速定位候选文档
  const candidatePaths = new Set<string>()
  for (const t of qTokens) {
    inverted.get(t)?.forEach((p) => candidatePaths.add(p))
  }
  if (!candidatePaths.size) return []

  const qSet = new Set(qTokens)
  const scored: KnowledgeHit[] = []
  for (const p of candidatePaths) {
    const doc = docs.get(p)
    if (!doc) continue
    if (category && doc.category !== category) continue

    const dt = docTokens.get(p)!
    const tt = titleTokens.get(p)!
    const tags = tagTokens.get(p)!
    let score = 0
    const hitTokens = new Set<string>()
    for (const t of qTokens) {
      if (!dt.has(t)) continue
      hitTokens.add(t)
      if (tt.has(t)) score += 3
      if (tags.has(t)) score += 2
      score += 1
    }
    if (!hitTokens.size) continue
    const coverage = hitTokens.size / qSet.size
    score *= 0.4 + 0.6 * coverage
    scored.push({ doc, score, snippet: bestSnippet(doc.content, qTokens) })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK)
}

/** 从文档里挑出最相关的一段（用于注入提示词，控制 token） */
export function bestSnippet(content: string, qTokens: string[], maxLen = 900): string {
  const blocks = content.split(/\n{2,}/)
  let best = ''
  let bestScore = -1
  for (const b of blocks) {
    const lower = b.toLowerCase()
    let sc = 0
    for (const t of qTokens) if (lower.includes(t)) sc += 1
    if (sc > bestScore) {
      bestScore = sc
      best = b
    }
  }
  if (!best || bestScore <= 0) best = blocks.slice(0, 2).join('\n\n')
  const trimmed = best.trim()
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + '\n…（已截断）' : trimmed
}
