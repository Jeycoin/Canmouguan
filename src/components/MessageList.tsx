import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
import { Markdown } from './Markdown'
import type { ChatMessage } from '../api'

const MAX_VISIBLE_MESSAGES = 30

interface MessageListProps {
  messages: ChatMessage[]
  streamingId: string | null
  thinkingId?: string | null
  onCopy: (text: string) => void
  onFollowUp: (text: string) => void
}

export interface MessageListHandle {
  scrollToBottom: () => void
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(
  ({ messages, streamingId, thinkingId, onCopy, onFollowUp }, ref) => {
    const listRef = useRef<HTMLDivElement>(null)

    useImperativeHandle(ref, () => ({
      scrollToBottom: () => {
        requestAnimationFrame(() => {
          const el = listRef.current
          if (el) el.scrollTop = el.scrollHeight
        })
      }
    }))

    // 只渲染最近 N 条，避免长会话 DOM 膨胀
    const visible = useMemo(() => {
      if (messages.length <= MAX_VISIBLE_MESSAGES) return messages
      return messages.slice(-MAX_VISIBLE_MESSAGES)
    }, [messages])

    const hasMore = messages.length > MAX_VISIBLE_MESSAGES

    return (
      <div className="chat scroll" ref={listRef}>
        {hasMore && (
          <div className="muted" style={{ textAlign: 'center', padding: '8px 0', fontSize: 11 }}>
            已隐藏 {messages.length - MAX_VISIBLE_MESSAGES} 条早期消息
          </div>
        )}

        {visible.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.kind === 'transcript' && <div className="msg-meta">🎙 面试官语音</div>}
            {m.kind === 'screenshot' && <div className="msg-meta">📷 截图</div>}
            {m.imageDataUrl && <img src={m.imageDataUrl} alt="截图" loading="lazy" />}
            {m.error ? (
              <div className="bubble error">⚠ {m.error}</div>
            ) : thinkingId === m.id && m.role === 'assistant' ? (
              // 强制思考的模型（glm-5 / R1 等）正文要等很久，这里至少让用户知道不是卡死了
              <div className="bubble thinking">
                <span className="dots-loader" />
                模型正在思考…（该型号会先输出长思考链，正文稍后才到）
              </div>
            ) : (
              <div className="bubble">
                <Markdown text={m.content} />
                {m.streaming && m.id === streamingId && <span className="cursor" />}
              </div>
            )}
            <div className="msg-meta" style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <span>{new Date(m.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
              {m.role === 'assistant' && !m.streaming && (
                <span className="msg-actions">
                  <button onClick={() => onCopy(m.content)}>复制</button>
                  <button onClick={() => onFollowUp(m.content)}>追问</button>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    )
  }
)
