import { api } from '../api'
import { useApp } from '../context'
import { useChat } from '../hooks/useChat'
import { ChatToolbar } from './ChatToolbar'
import { ChatComposer } from './ChatComposer'
import { MessageList } from './MessageList'

export function ChatPanel() {
  const { session, windowState } = useApp()
  const {
    messages,
    setMessages,
    input,
    setInput,
    live,
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
  } = useChat()

  return (
    <div className="body">
      <ChatToolbar
        session={session}
        elapsed={recorder.elapsed}
        ctxHits={ctxHits}
        hasMessages={!!messages.length}
        hasAssistant={messages.some((m) => m.role === 'assistant')}
        streamingId={streamingId}
        onStart={() => void startInterview()}
        onEnd={() => void endInterview()}
        onClear={() => setMessages([])}
        onAbort={() => void api.llmAbort()}
        onRegenerate={() => void regenerate()}
      />

      {!messages.length && !live ? (
        <div className="chat scroll">
          <div className="empty">
            <div className="big">◍</div>
            <div>点击麦克风开始录音，停止后自动转写并交给 AI</div>
            <div className="tip">
              截图快捷键可一键分析屏幕上的题目。
              <br />
              全局快捷键在后台与全屏下依然生效，鼠标开启穿透时点击会穿过本窗口。
            </div>
          </div>
        </div>
      ) : (
        <MessageList
          ref={listRef}
          messages={messages}
          streamingId={streamingId}
          thinkingId={thinkingId}
          onCopy={copy}
          onFollowUp={send}
        />
      )}

      {live && (
        <div style={{ padding: '0 11px' }}>
          <div className="live-box">{live}</div>
        </div>
      )}

      <ChatComposer
        input={input}
        setInput={setInput}
        inputRef={inputRef}
        onSend={send}
        onScreenshot={() => void takeScreenshot()}
        recording={recording}
        stopping={recorder.state === 'stopping'}
        muted={recorder.muted}
        level={recorder.level}
        elapsed={recorder.elapsed}
        sttLabel={sttLabel}
        channels={(['interviewer', 'candidate'] as const).map((ch) => ({
          channel: ch,
          active: recorder.channelState[ch]?.active ?? false,
          level: recorder.channelState[ch]?.level ?? 0
        }))}
        clickThrough={windowState.clickThrough}
        onToggleRecord={() => void recorder.toggle()}
        onMute={recorder.panicMute}
        onUnmute={recorder.unmute}
        disabled={panelBusy}
      />
    </div>
  )
}
