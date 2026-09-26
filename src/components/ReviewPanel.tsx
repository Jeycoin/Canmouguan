import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../context'
import type { InterviewSession, MemoryItem } from '../api'

export function ReviewPanel() {
  const { toast } = useApp()
  const [cards, setCards] = useState<MemoryItem[]>([])
  const [sessions, setSessions] = useState<InterviewSession[]>([])
  const [idx, setIdx] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    const [c, s] = await Promise.all([api.memDue(50), api.sessionList()])
    setCards(c)
    setSessions(s)
    setIdx(0)
    setRevealed(false)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const card = cards[idx]

  const answer = async (result: 'mastered' | 'fuzzy' | 'unknown') => {
    if (!card) return
    await api.memReview(card.id, result)
    toast(result === 'mastered' ? '已掌握，下次复习间隔延长' : result === 'fuzzy' ? '标记模糊，保持当前间隔' : '标记不会，明天再来', 'info')
    setRevealed(false)
    if (idx + 1 >= cards.length) await reload()
    else setIdx(idx + 1)
  }

  return (
    <div className="body">
      <div className="panel scroll" style={{ flex: 1, minHeight: 0 }}>
        <div className="section-title">间隔重复复习</div>
        {!card && <div className="muted">今天没有到期的复习卡片。结束面试并复盘后会自动生成。</div>}

        {card && (
          <>
            <div className="review-card">
              <div className="review-q">{card.question}</div>
              <div className="row wrap" style={{ gap: 5, marginBottom: 6 }}>
                {card.knowledgePoints.map((k) => (
                  <span key={k} className="pill">{k}</span>
                ))}
                {card.source.company && <span className="pill">{card.source.company}</span>}
                <span className="pill">复习 {card.reviewCount} 次</span>
                <span className="pill">掌握 {card.mastery}/5</span>
              </div>

              {revealed ? (
                <>
                  {card.referenceAnswer && (
                    <div className="review-sec">
                      <div className="k">参考思路</div>
                      <div className="v">{card.referenceAnswer}</div>
                    </div>
                  )}
                  {card.weakPoints.length > 0 && (
                    <div className="review-sec">
                      <div className="k">曾经的薄弱点</div>
                      <div className="v">{card.weakPoints.join('、')}</div>
                    </div>
                  )}
                  {card.suggestions && (
                    <div className="review-sec">
                      <div className="k">改进建议</div>
                      <div className="v">{card.suggestions}</div>
                    </div>
                  )}
                </>
              ) : (
                <div className="muted" style={{ marginTop: 6 }}>
                  先在心里答一遍，再点「显示答案」自检。
                </div>
              )}

              <div className="row wrap" style={{ gap: 6, marginTop: 12 }}>
                {!revealed ? (
                  <button className="btn primary sm" onClick={() => setRevealed(true)}>显示答案</button>
                ) : (
                  <>
                    <button className="btn sm" onClick={() => void answer('mastered')}>✅ 已掌握</button>
                    <button className="btn sm" onClick={() => void answer('fuzzy')}>🤔 模糊</button>
                    <button className="btn sm danger" onClick={() => void answer('unknown')}>❌ 不会</button>
                  </>
                )}
                <span className="spacer" />
                <span className="muted">
                  {idx + 1} / {cards.length}
                </span>
              </div>
            </div>
          </>
        )}

        <div className="section-title">历史面试</div>
        {!sessions.length && <div className="muted">还没有面试记录。</div>}
        {sessions.map((s) => (
          <div className="card" key={s.id}>
            <div className="card-head">
              <div style={{ flex: 1 }}>
                <div className="card-title">
                  {s.company || '未命名公司'} · {s.role || '未填岗位'}
                </div>
                <div className="card-sub">
                  {s.round} · {new Date(s.startedAt).toLocaleString('zh-CN')} · 转写 {s.transcripts.length} 条 · 截图{' '}
                  {s.screenshots.length} 次 · AI 回答 {s.aiAnswers.length} 条
                </div>
              </div>
              <div className="row" style={{ gap: 5 }}>
                <button
                  className="btn sm ghost"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    const r = await api.reviewRun(s.id)
                    setBusy(false)
                    toast(r.ok ? `复盘完成，新增 ${r.count ?? 0} 条记忆` : `复盘失败：${r.message}`, r.ok ? 'info' : 'error')
                    await reload()
                  }}
                >
                  重新复盘
                </button>
                <button
                  className="btn sm danger"
                  onClick={async () => {
                    await api.sessionDelete(s.id)
                    await reload()
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
