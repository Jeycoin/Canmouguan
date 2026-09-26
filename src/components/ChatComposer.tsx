import { formatDuration } from '../hooks/useChat'

/** 每条通道的实时电平，用来确认"那一路到底有没有在收到声音" */
export interface ChannelIndicator {
  channel: 'interviewer' | 'candidate'
  active: boolean
  level: number
}

interface ChatComposerProps {
  input: string
  setInput: (v: string) => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  onSend: (text: string) => void
  onScreenshot: () => void
  recording: boolean
  stopping: boolean
  muted: boolean
  level: number
  elapsed: number
  sttLabel: string
  /** 双通道各自的采集状态；为空表示没开任何通道 */
  channels?: ChannelIndicator[]
  clickThrough: boolean
  disabled?: boolean
  onToggleRecord: () => void
  onMute: () => void
  onUnmute: () => void
}

export function ChatComposer({
  input,
  setInput,
  inputRef,
  onSend,
  onScreenshot,
  recording,
  stopping,
  muted,
  level,
  elapsed,
  sttLabel,
  channels = [],
  clickThrough,
  disabled,
  onToggleRecord,
  onMute,
  onUnmute
}: ChatComposerProps) {
  return (
    <div className="composer">
      <div className="composer-row">
        <button
          className={`icon-btn ${recording ? 'rec' : ''}`}
          title="开始 / 停止录音"
          onClick={onToggleRecord}
          disabled={stopping}
        >
          {recording ? '■' : '🎙'}
        </button>
        <button
          className={`icon-btn ${muted ? 'on' : ''}`}
          title={muted ? '取消静音' : '静音'}
          onClick={() => (muted ? onUnmute() : onMute())}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        <button className="icon-btn" title="一键截图并分析" onClick={onScreenshot} disabled={disabled}>
          📷
        </button>
        <div className="level">
          <i style={{ width: `${level * 100}%` }} />
        </div>
        <span className="pill">{sttLabel}</span>
        {recording && <span className="pill">{formatDuration(elapsed)}</span>}
        {clickThrough && <span className="pill warn">穿透中</span>}
      </div>

      {/*
        双通道电平必须分开显示。
        两条链路是独立采集的，混在一个电平条里就分不清"是对方没说话"还是"我这边没采到" ——
        而这两件事的处理方式完全不同（前者正常，后者要检查设备授权）。
      */}
      {recording && channels.length > 0 && (
        <div className="composer-row" style={{ gap: 12, paddingTop: 0 }}>
          {channels.map((c) => (
            <div key={c.channel} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
              <span className="pill" style={{ whiteSpace: 'nowrap' }}>
                {c.channel === 'interviewer' ? '面试官' : '我'}
              </span>
              <div className="level" style={{ flex: 1 }}>
                <i style={{ width: `${(c.active ? c.level : 0) * 100}%` }} />
              </div>
              <span className="pill" style={{ opacity: c.active ? 1 : 0.45 }}>
                {c.active ? '采集中' : '未开启'}
              </span>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={inputRef}
        className="input"
        style={{ minHeight: 52 }}
        placeholder="手动输入问题，Enter 发送（Shift+Enter 换行）"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSend(input)
          }
        }}
      />
    </div>
  )
}
