import { getSettings } from './store'
import { searchKnowledge } from './knowledge'
import { renderMemories, searchMemories } from './memory'
import type { ChatMessage } from '../shared/types'

export interface PromptVars {
  company?: string
  role?: string
  jd?: string
  round?: string
  transcript?: string
  question?: string
  lang?: string
  knowledge?: string
  memory?: string
  material?: string
  snippets?: string
  memories?: string
  category?: string
  name?: string
  years?: string
  date?: string
}

const VAR_RE = /\{\{\s*([\w.]+)\s*\}\}/g

export function renderTemplate(tpl: string, vars: PromptVars): string {
  return tpl.replace(VAR_RE, (_all, key: string) => {
    const v = (vars as Record<string, unknown>)[key]
    if (v === undefined || v === null) return ''
    return String(v)
  })
}

/** 未识别/未提供的变量列表，用于设置页提示 */
export function findUnknownVars(tpl: string): string[] {
  const known = new Set([
    'company', 'role', 'jd', 'round', 'transcript', 'question', 'lang',
    'knowledge', 'memory', 'material', 'snippets', 'memories', 'category',
    'name', 'years', 'date'
  ])
  const out = new Set<string>()
  for (const m of tpl.matchAll(VAR_RE)) {
    if (!known.has(m[1])) out.add(m[1])
  }
  return [...out]
}

export function listUsedVars(tpl: string): string[] {
  const out = new Set<string>()
  for (const m of tpl.matchAll(VAR_RE)) out.add(m[1])
  return [...out]
}

/** 组装上下文（知识库 + 记忆库自动检索） */
export function buildContext(query: string): { knowledge: string; memory: string; hits: number; memHits: number } {
  const s = getSettings()

  let knowledge = ''
  let hits = 0
  try {
    const res = searchKnowledge(query, 3)
    hits = res.length
    knowledge = res.length
      ? res
          .map((h) =>
            renderTemplate(s.prompts.knowledgeInjection, {
              category: h.doc.category,
              snippets: `【${h.doc.title}】\n${h.snippet}`
            })
          )
          .join('\n\n')
      : '（知识库无相关片段）'
  } catch (err) {
   console.error('[prompt] 忽略异常', err)
    knowledge = '（知识库检索失败）'
  }

  let memory = ''
  let memHits = 0
  try {
    if (s.memory.enabled) {
      const mems = searchMemories({ text: query, topK: s.memory.retrievalTopK })
      memHits = mems.length
      memory = renderTemplate(s.prompts.memoryInjection, {
        memories: renderMemories(mems)
      })
    } else {
      memory = '（记忆库已关闭）'
    }
  } catch (err) {
   console.error('[prompt] 忽略异常', err)
    memory = '（记忆检索失败）'
  }

  return { knowledge, memory, hits, memHits }
}

export function baseVars(extra: PromptVars = {}): PromptVars {
  const s = getSettings()
  return {
    company: s.interview.company || '（未填写）',
    role: s.interview.role || '（未填写）',
    jd: s.interview.jd || '（未填写）',
    round: s.interview.round || '（未填写）',
    // 代码题回答语言：可在「设置 → 面试信息 → 代码语言」里改，默认 Java
    lang: s.interview.codeLang?.trim() || 'Java',
    date: new Date().toLocaleDateString(),
    ...extra
  }
}

/** 生成完整的 system prompt（已渲染变量 + 注入上下文） */
export function buildSystemPrompt(query: string): string {
  const s = getSettings()
  const ctx = buildContext(query)
  return renderTemplate(s.prompts.system, baseVars({ knowledge: ctx.knowledge, memory: ctx.memory }))
}

export function buildTranscriptPrompt(transcript: string): { system: string; user: string } {
  const s = getSettings()
  const ctx = buildContext(transcript)
  const system = buildSystemPrompt(transcript)
  const user = renderTemplate(s.prompts.transcript, baseVars({ transcript, knowledge: ctx.knowledge, memory: ctx.memory }))
  return { system, user }
}

export function buildScreenshotPrompt(): { system: string; user: string } {
  const s = getSettings()
  const query = '面试题目 截图 算法 代码'
  const ctx = buildContext(query)
  const system = buildSystemPrompt(query)
  const user = renderTemplate(s.prompts.screenshot, baseVars({ knowledge: ctx.knowledge, memory: ctx.memory }))
  return { system, user }
}

export function buildReviewPrompt(material: string): { system: string; user: string } {
  const s = getSettings()
  const system =
    '你是一名严格的面试复盘教练，只输出合法 JSON 数组，绝不输出多余文字、注释或 markdown 围栏。'
  const user = renderTemplate(s.prompts.review, baseVars({ material }))
  return { system, user }
}

/** UI 上的多轮历史 → LLM messages（只保留最近 N 轮；截图轮次降级为文字占位，避免 base64 反复发送） */
export function historyToMessages(history: ChatMessage[], maxTurns = 4): { role: 'user' | 'assistant'; content: string }[] {
  const cleaned = history.filter((m) => !m.streaming && !m.error && m.content.trim())
  const turns = cleaned.slice(-maxTurns * 2)
  return turns.map((m) => ({
    role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    // 图片消息保留文字描述，不转发图片 URL/ base64
    content: m.content
  }))
}
