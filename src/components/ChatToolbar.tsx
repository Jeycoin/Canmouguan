import { formatDuration } from '../hooks/useChat'
import type { InterviewSession } from '../api'

interface ChatToolbarProps {
  session: InterviewSession | null
  elapsed: number
  ctxHits: { hits: number; memHits: number } | null
  hasMessages: boolean
  hasAssistant: boolean
  streamingId: string | null
  onStart: () => void
  onEnd: () => void
  onClear: () => void
  onAbort: () => void
  onRegenerate: () => void
}

export function ChatToolbar({
  session,
  elapsed,
  ctxHits,
  hasMessages,
  hasAssistant,
  streamingId,
  onStart,
  onEnd,
  onClear,
  onAbort,
  onRegenerate
}: ChatToolbarProps) {
  return (
    <div className="row wrap" style={{ padding: '7px 11px 0', gap: 6 }}>
      {session ? (
        <>
          <span className="pill ok">● 面试进行中 {formatDuration(elapsed)}</span>
          <button className="btn sm" onClick={onEnd}>
            结束面试并复盘
          </button>
        </>
      ) : (
        <button className="btn sm" onClick={onStart}>
          ● 开始面试
        </button>
      )}
      {ctxHits && (
        <span className="pill">
          知识库 {ctxHits.hits} · 记忆 {ctxHits.memHits}
        </span>
      )}
      <span className="spacer" />
      <button className="btn sm ghost" onClick={onClear} disabled={!hasMessages}>
        清空
      </button>
      <button className="btn sm ghost" onClick={onAbort} disabled={!streamingId}>
        停止生成
      </button>
      <button className="btn sm ghost" onClick={onRegenerate} disabled={!hasAssistant}>
        重新生成
      </button>
    </div>
  )
}
