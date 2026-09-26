import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, on } from '../api'
import { useApp } from '../context'
import { useRecorder, formatDuration } from './useRecorder'
import type { MessageListHandle } from '../components/MessageList'
import type { ChatMessage, InterviewSession } from '../api'

let seq = 0
const nid = () => `m${++seq}`

export interface UseChatReturn {
  messages: ChatMessage[]
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  input: string
  setInput: (v: string) => void
  live: string
  sttState: string
  streamingId: string | null
  /** 该消息的模型正在输出思考链、正文还没到（推理模型常见） */
  thinkingId: string | null
  ctxHits: { hits: number; memHits: number } | null
  panelBusy: boolean
  listRef: React.RefObject<MessageListHandle | null>
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  send: (text: string) => Promise<void>
  takeScreenshot: () => Promise<void>
  regenerate: () => Promise<void>
  copy: (text: string) => Promise<void>
  startInterview: () => Promise<void>
  endInterview: () => Promise<void>
  recorder: ReturnType<typeof useRecorder>
  recording: boolean
  sttLabel: string
}

export function useChat(): UseChatReturn {
  const { settings, toast, setSession, recToggleSignal, shotSignal, muteSignal } = useApp()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [live, setLive] = useState('')
  const [sttState, setSttState] = useState<string>('idle')
  const [streamingId, setStreamingId] = useState<string | null>(null)
  /** 正在"只吐思考链、还没出正文"的消息 id */
  const [thinkingId, setThinkingId] = useState<string | null>(null)
  const [ctxHits, setCtxHits] = useState<{ hits: number; memHits: number } | null>(null)
  const [panelBusy, setPanelBusy] = useState(false)

  const listRef = useRef<MessageListHandle>(null)
  const messagesRef = useRef<ChatMessage[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pendingDeltas = useRef<Record<string, string>>({})
  const flushRef = useRef<number | null>(null)
  const lastRecSignal = useRef(recToggleSignal)
  const lastShotSignal = useRef(shotSignal)
  const lastMuteSignal = useRef(muteSignal)
  messagesRef.current = messages

  const scrollToBottom = useCallback(() => {
    listRef.current?.scrollToBottom()
  }, [])

  const flushDeltas = useCallback(() => {
    flushRef.current = null
    const deltas = pendingDeltas.current
    pendingDeltas.current = {}
    if (!Object.keys(deltas).length) return
    setMessages((m) => {
      let changed = false
      const next = m.map((x) => {
        const d = deltas[x.id]
        if (!d || x.role !== 'assistant') return x
        changed = true
        return { ...x, content: x.content + d }
      })
      return changed ? next : m
    })
    scrollToBottom()
  }, [scrollToBottom])

  const audioChannels = useMemo(() => {
    const ch = settings?.stt.channels
    if (!ch) return ['interviewer', 'candidate'] as const
    return (['interviewer', 'candidate'] as const).filter((c) => ch[c]?.enabled)
  }, [settings?.stt.channels])

  const sendModeOf = useCallback(
    (channel: 'interviewer' | 'candidate') => settings?.stt.channels?.[channel]?.sendMode ?? 'manual',
    [settings?.stt.channels]
  )

  const recorder = useRecorder({
    channels: [...audioChannels],
    onError: (msg) => toast(msg, 'error'),
    onChannelError: (channel, msg) =>
      toast(`${channel === 'interviewer' ? '面试官' : '我的'}通道：${msg}`, 'warn')
  })

  /* -------------------------- LLM 流式事件 -------------------------- */

  useEffect(() => {
    const offs: (() => void)[] = []
    offs.push(
      on<{ id: string }>('llm:start', ({ id }) => {
        setStreamingId(id)
        setMessages((m) => [...m, { id, role: 'assistant', content: '', at: Date.now(), streaming: true }])
        scrollToBottom()
      })
    )
    offs.push(
      on<{ id: string }>('llm:thinking', ({ id }) => {
        setThinkingId(id)
      })
    )
    offs.push(
      on<{ id: string; delta: string }>('llm:delta', ({ id, delta }) => {
        // 正文一到就退出"思考中"状态
        setThinkingId((cur) => (cur === id ? null : cur))
        pendingDeltas.current[id] = (pendingDeltas.current[id] ?? '') + delta
        if (flushRef.current == null) {
          flushRef.current = window.requestAnimationFrame(flushDeltas)
        }
      })
    )
    offs.push(
      on<{ id: string; text: string }>('llm:done', ({ id, text }) => {
        setMessages((m) => m.map((x) => (x.id === id ? { ...x, content: text || x.content, streaming: false } : x)))
        setStreamingId(null)
        setThinkingId(null)
        scrollToBottom()
      })
    )
    offs.push(
      on<{ id: string; message: string }>('llm:error', ({ id, message }) => {
        setMessages((m) =>
          m.map((x) => (x.id === id ? { ...x, streaming: false, error: message, content: x.content || '' } : x))
        )
        setStreamingId(null)
        setThinkingId(null)
        toast(message, 'error')
      })
    )
    return () => {
      offs.forEach((f) => f())
      if (flushRef.current != null) cancelAnimationFrame(flushRef.current)
    }
  }, [scrollToBottom, toast, flushDeltas])

  /* --------------------------- STT 事件（双通道） --------------------------- */

  useEffect(() => {
    const offs: (() => void)[] = []
    // 状态按通道聚合：任一路在听就显示"监听中"，全部空闲才算 idle
    const states = new Map<string, string>()
    const recompute = () => {
      const vals = [...states.values()]
      if (!vals.length) return setSttState('idle')
      if (vals.includes('error')) return setSttState('error')
      if (vals.includes('listening') || vals.includes('connecting')) return setSttState('listening')
      if (vals.includes('processing')) return setSttState('processing')
      return setSttState('idle')
    }

    offs.push(
      on<{ channel: string; state: string }>('stt:state', ({ channel, state }) => {
        states.set(channel, state)
        recompute()
      })
    )

    offs.push(
      on<{ channel: string; text: string; stable: boolean }>('stt:partial', ({ channel, text }) => {
        // 只有面试官的实时字幕需要展示 —— 它决定了"我该答什么"
        if (channel !== 'interviewer') return
        setLive((prev) => {
          const idx = prev.lastIndexOf('\n')
          if (idx < 0) return text
          return prev.slice(0, idx + 1) + text
        })
      })
    )

    offs.push(
      on<{ channel: 'interviewer' | 'candidate'; text: string; skipped?: boolean; reason?: string }>(
        'stt:final',
        ({ channel, text, skipped, reason }) => {
          if (channel === 'interviewer') setLive('')
          if (skipped || !text) {
            if (reason) toast(reason, 'warn')
            return
          }
          /*
           * 两条通道对最终文本的处理**故意不同** —— 这正是双通道存在的理由：
           * - interviewer：面试官的问题，要立刻喂给 AI 出答案
           * - candidate：我自己的回答，进输入框供事后整理，不该触发新提问
           */
          const mode = sendModeOf(channel)
          if (mode === 'edit') {
            setInput((prev) => (prev ? `${prev}\n${text}` : text))
            inputRef.current?.focus()
            toast(channel === 'candidate' ? '我的回答已转写，可编辑后发送' : '转写完成，可编辑后回车发送', 'info')
          } else {
            setMessages((m) => [
              ...m,
              {
                id: nid(),
                role: 'user',
                content: text,
                at: Date.now(),
                kind: 'transcript',
                channel
              }
            ])
            if (mode === 'manual') toast('已捕获转写，按发送交给 AI', 'info')
          }
          scrollToBottom()
        }
      )
    )

    offs.push(
      on<{ channel: string; message: string }>('stt:error', ({ channel, message }) =>
        toast(`${channel === 'candidate' ? '我的通道' : '面试官通道'}：${message}`, 'error')
      )
    )
    return () => offs.forEach((f) => f())
  }, [sendModeOf, toast, scrollToBottom])

  /* ---------------------- 全局快捷键：录音切换 ---------------------- */

  useEffect(() => {
    if (recToggleSignal > 0 && recToggleSignal !== lastRecSignal.current) {
      lastRecSignal.current = recToggleSignal
      void recorder.toggle()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recToggleSignal])

  useEffect(() => {
    if (shotSignal > 0 && shotSignal !== lastShotSignal.current) {
      lastShotSignal.current = shotSignal
      void takeScreenshot()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotSignal])

  /* ---------------------- 全局快捷键：紧急静音 ---------------------- */

  useEffect(() => {
    if (muteSignal > 0 && muteSignal !== lastMuteSignal.current) {
      lastMuteSignal.current = muteSignal
      recorder.panicMute()
      toast(
        recorder.state === 'recording'
          ? '已紧急静音：麦克风与系统音不再采集，也不会上传'
          : '已紧急静音（当前未在录音）',
        'warn'
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muteSignal])

  /* ------------------------------ 行为 ------------------------------ */

  const send = useCallback(
    async (text: string) => {
      const t = text.trim()
      if (!t) return
      // 快照必须在 setMessages 之前取：主进程会自己把这条 user 拼到 messages 末尾，
      // 若这里传的是刚追加过新 user 的列表，模型就会看到两条一模一样的提问。
      const historySnapshot = messagesRef.current
      setMessages((m) => [...m, { id: nid(), role: 'user', content: t, at: Date.now() }])
      setInput('')
      try {
        const c = await api.kbContext(t)
        setCtxHits({ hits: c.hits, memHits: c.memHits })
      } catch (err) {
        // 上下文检索失败不该拦住提问本身，降级为不带检索上下文继续
        console.warn('[useChat] 上下文检索失败', err)
        setCtxHits(null)
      }
      await api.llmAsk(t, historySnapshot)
      scrollToBottom()
    },
    [scrollToBottom]
  )

  /**
   * 截图提问。
   * 这里刻意先插一条占位的 user 气泡再发请求：采集本身要几百毫秒，
   * 早一点的反馈比"什么都看不到地干等"体验好得多；等主进程返回再把缩略图补上去。
   * 整张图不再经渲染层中转，省掉一次 240KB 级的 IPC 往返。
   */
  const takeScreenshot = useCallback(async () => {
    const historySnapshot = messagesRef.current
    const placeholderId = nid()
    setMessages((m) => [
      ...m,
      { id: placeholderId, role: 'user', content: '（正在截取屏幕…）', at: Date.now(), kind: 'screenshot' }
    ])
    scrollToBottom()
    setPanelBusy(true)
    try {
      const res = await api.llmAskShot(undefined, historySnapshot)
      setMessages((m) =>
        m.map((x) =>
          x.id === placeholderId
            ? { ...x, content: '（截图）请分析这道题', imageDataUrl: res.thumbDataUrl }
            : x
        )
      )
      scrollToBottom()
    } catch (err) {
      setMessages((m) => m.filter((x) => x.id !== placeholderId))
      toast(`截图失败：${(err as Error).message}`, 'error')
    } finally {
      setPanelBusy(false)
    }
  }, [scrollToBottom, toast])

  const regenerate = useCallback(async () => {
    // 先把最后一条 assistant 从本地列表里摘掉，再用「去掉它之后」的历史重新生成。
    // 快照取在前，主进程那边也会自己 pop 掉末尾 assistant，两边口径一致。
    const withoutLastAssistant = [...messagesRef.current]
    const lastIdx = withoutLastAssistant.map((m) => m.role).lastIndexOf('assistant')
    if (lastIdx >= 0) withoutLastAssistant.splice(lastIdx, 1)
    setMessages(withoutLastAssistant)
    await api.llmRegenerate(withoutLastAssistant)
    scrollToBottom()
  }, [scrollToBottom])

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        toast('已复制', 'info')
      } catch {
        toast('复制失败', 'error')
      }
    },
    [toast]
  )

  const startInterview = useCallback(async () => {
    if (!settings) return
    if (!settings.interview.company && !settings.interview.role) {
      toast('建议先在设置 → 面试信息里填写公司与岗位', 'warn')
    }
    const s = await api.sessionStart({
      company: settings.interview.company,
      role: settings.interview.role,
      round: settings.interview.round
    })
    const cur = await api.sessionCurrent()
    setSession((cur as InterviewSession | null) ?? ({ id: s.id } as InterviewSession))
    toast('面试已开始，结束后会自动复盘', 'info')
  }, [settings, setSession, toast])

  const endInterview = useCallback(async () => {
    const res = await api.sessionEnd()
    if (!res.ok) {
      toast(res.message ?? '结束失败', 'warn')
      return
    }
    setSession(null)
    toast(res.review === 'running' ? '面试已结束，正在生成复盘…' : '面试已结束', 'info')
  }, [setSession, toast])

  const sttLabel = useMemo(() => {
    switch (sttState) {
      case 'connecting':
        return '连接中…'
      case 'listening':
        return '正在聆听'
      case 'processing':
        return '转写中…'
      case 'error':
        return '转写出错'
      default:
        return recorder.state === 'recording' ? '录音中' : '待机'
    }
  }, [sttState, recorder.state])

  const recording = recorder.state === 'recording' || recorder.state === 'starting'

  return {
    messages,
    setMessages,
    input,
    setInput,
    live,
    sttState,
    streamingId,
    thinkingId,
    ctxHits,
    panelBusy,
    listRef,
    inputRef,
    send,
    takeScreenshot,
    regenerate,
    copy,
    startInterview,
    endInterview,
    recorder,
    recording,
    sttLabel
  }
}

export { formatDuration }
