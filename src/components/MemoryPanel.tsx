import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../context'
import type { MemoryItem } from '../api'

interface Stats {
  total: number
  byMastery: number[]
  due: number
  topTags: [string, number][]
  topKnowledgePoints: [string, number][]
}

export function MemoryPanel() {
  const { toast } = useApp()
  const [items, setItems] = useState<MemoryItem[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState<string>('')
  const [masteryMax, setMasteryMax] = useState<number | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [editing, setEditing] = useState<MemoryItem | null>(null)

  const reload = useCallback(async () => {
    const [list, st] = await Promise.all([api.memList(), api.memStats()])
    setItems(list)
    setStats(st)
  }, [])

  useEffect(() => {
    void reload()
    const off = api.on('memory:changed', () => void reload())
    return () => off()
  }, [reload])

  useEffect(() => {
    const t = window.setTimeout(() => {
      void api
        .memSearch({ text: query, tags: tagFilter ? [tagFilter] : undefined, maxMastery: masteryMax ?? undefined, topK: 50 })
        .then(setItems)
    }, 220)
    return () => window.clearTimeout(t)
  }, [query, tagFilter, masteryMax])

  const allTags = Array.from(new Set(items.flatMap((i) => i.tags)))

  const exportJson = async () => {
    const content = await api.memExportJson()
    const r = await api.memSaveFile(content, 'json')
    if (r.ok) toast(`已导出到 ${r.path}`, 'info')
  }
  const exportMd = async () => {
    const content = await api.memExportMarkdown()
    const r = await api.memSaveFile(content, 'md')
    if (r.ok) toast(`已导出到 ${r.path}`, 'info')
  }
  const doImport = async () => {
    const json = await api.memPickFile()
    if (!json) return
    try {
      const n = await api.memImport(json, 'merge')
      toast(`已导入并合并 ${n} 条新记忆`, 'info')
      await reload()
    } catch (err) {
      toast(`导入失败：${(err as Error).message}`, 'error')
    }
  }

  return (
    <div className="body">
      <div className="panel tight" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="row" style={{ gap: 6 }}>
          <input className="input" placeholder="检索记忆：问题 / 知识点 / 薄弱点" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn sm ghost" onClick={() => void reload()}>⟳</button>
        </div>
        <div className="row wrap" style={{ gap: 5, marginTop: 7 }}>
          <span className={`pill clickable ${!tagFilter ? 'ok' : ''}`} onClick={() => setTagFilter('')}>全部标签</span>
          {allTags.slice(0, 10).map((t) => (
            <span key={t} className={`pill clickable ${tagFilter === t ? 'ok' : ''}`} onClick={() => setTagFilter(t)}>
              #{t}
            </span>
          ))}
          <span className={`pill clickable ${masteryMax === 2 ? 'ok' : ''}`} onClick={() => setMasteryMax(masteryMax === 2 ? null : 2)}>
            只看薄弱（≤2）
          </span>
        </div>
      </div>

      <div className="panel scroll" style={{ flex: 1, minHeight: 0 }}>
        {stats && (
          <div className="grid3" style={{ marginBottom: 11 }}>
            <div className="stat">
              <div className="v">{stats.total}</div>
              <div className="k">记忆总量</div>
            </div>
            <div className="stat">
              <div className="v">{stats.due}</div>
              <div className="k">待复习</div>
            </div>
            <div className="stat">
              <div className="v">{stats.topKnowledgePoints.length}</div>
              <div className="k">知识点</div>
            </div>
          </div>
        )}

        <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
          <button className="btn sm" onClick={() => void exportJson()}>导出 JSON</button>
          <button className="btn sm" onClick={() => void exportMd()}>导出 Markdown</button>
          <button className="btn sm ghost" onClick={() => void doImport()}>导入</button>
          <button
            className="btn sm danger"
            onClick={async () => {
              if (!window.confirm('确定清空全部记忆？该操作不可恢复。')) return
              await api.memClear()
              await reload()
              toast('记忆库已清空', 'info')
            }}
          >
            清空
          </button>
        </div>

        {items.map((m) => {
          const open = openId === m.id
          return (
            <div className="card" key={m.id}>
              <div className="card-head" onClick={() => setOpenId(open ? null : m.id)} style={{ cursor: 'pointer' }}>
                <div style={{ flex: 1 }}>
                  <div className="card-title">{m.question}</div>
                  <div className="row wrap" style={{ gap: 5, marginTop: 5 }}>
                    <span className="mastery">
                      {[0, 1, 2, 3, 4, 5].map((i) => (
                        <i key={i} className={i < m.mastery ? 'on' : ''} />
                      ))}
                    </span>
                    <span className="pill">{m.mastery}/5</span>
                    {m.source.company && <span className="pill">{m.source.company}</span>}
                    {m.source.round && <span className="pill">{m.source.round}</span>}
                    {m.tags.map((t) => (
                      <span key={t} className="pill">#{t}</span>
                    ))}
                    {m.nextReviewAt <= Date.now() && <span className="pill warn">待复习</span>}
                  </div>
                </div>
                <span className="muted">{open ? '收起' : '展开'}</span>
              </div>

              {open && (
                <>
                  <div className="divider" />
                  {editing?.id === m.id ? (
                    <>
                      <div className="field">
                        <label>问题</label>
                        <input className="input" value={editing.question} onChange={(e) => setEditing({ ...editing, question: e.target.value })} />
                      </div>
                      <div className="field">
                        <label>参考思路</label>
                        <textarea className="input" value={editing.referenceAnswer} onChange={(e) => setEditing({ ...editing, referenceAnswer: e.target.value })} />
                      </div>
                      <div className="field">
                        <label>薄弱点（逗号分隔）</label>
                        <input className="input" value={editing.weakPoints.join('，')} onChange={(e) => setEditing({ ...editing, weakPoints: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })} />
                      </div>
                      <div className="field">
                        <label>标签（逗号分隔）</label>
                        <input className="input" value={editing.tags.join(',')} onChange={(e) => setEditing({ ...editing, tags: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })} />
                      </div>
                      <Slider2 value={editing.mastery} onChange={(v) => setEditing({ ...editing, mastery: v })} />
                      <div className="row" style={{ gap: 6 }}>
                        <button
                          className="btn sm primary"
                          onClick={async () => {
                            await api.memUpdate(m.id, {
                              question: editing.question,
                              referenceAnswer: editing.referenceAnswer,
                              weakPoints: editing.weakPoints,
                              tags: editing.tags,
                              mastery: editing.mastery
                            })
                            setEditing(null)
                            await reload()
                            toast('已保存', 'info')
                          }}
                        >
                          保存
                        </button>
                        <button className="btn sm ghost" onClick={() => setEditing(null)}>取消</button>
                      </div>
                    </>
                  ) : (
                    <>
                      {m.knowledgePoints.length > 0 && (
                        <div className="card-body">
                          <b>知识点：</b>
                          {m.knowledgePoints.join('、')}
                        </div>
                      )}
                      {m.referenceAnswer && (
                        <div className="card-body">
                          <b>参考思路：</b>
                          {m.referenceAnswer}
                        </div>
                      )}
                      {m.myAnswer && (
                        <div className="card-body">
                          <b>我的回答：</b>
                          {m.myAnswer}
                        </div>
                      )}
                      {m.weakPoints.length > 0 && (
                        <div className="card-body">
                          <b>薄弱点：</b>
                          {m.weakPoints.join('、')}
                        </div>
                      )}
                      {m.suggestions && (
                        <div className="card-body">
                          <b>改进建议：</b>
                          {m.suggestions}
                        </div>
                      )}
                      <div className="row wrap" style={{ gap: 6, marginTop: 9 }}>
                        <button className="btn sm ghost" onClick={() => setEditing(m)}>编辑</button>
                        <button
                          className="btn sm ghost"
                          onClick={async () => {
                            await api.llmAsk(`请针对这个面试问题，给我一份更好的回答：\n${m.question}\n\n我之前暴露的问题是：${m.weakPoints.join('、') || '无'}`, [])
                            toast('已提交，切到「对话」查看', 'info')
                          }}
                        >
                          让 AI 重答
                        </button>
                        <button
                          className="btn sm danger"
                          onClick={async () => {
                            await api.memDelete(m.id)
                            await reload()
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )
        })}

        {!items.length && (
          <div className="muted">还没有记忆。结束一次面试后会自动复盘并生成知识点；也可以从 JSON 导入。</div>
        )}
      </div>
    </div>
  )
}

function Slider2({ value, onChange }: { value: number; onChange: (v: MemoryItem['mastery']) => void }) {
  return (
    <div className="field">
      <label>掌握程度 {value}/5</label>
      <input className="range" type="range" min={0} max={5} step={1} value={value} onChange={(e) => onChange(Number(e.target.value) as MemoryItem['mastery'])} />
    </div>
  )
}
