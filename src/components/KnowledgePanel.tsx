import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../context'
import { Markdown } from './Markdown'
import type { KnowledgeDoc, KnowledgeHit } from '../api'

export function KnowledgePanel() {
  const { toast } = useApp()
  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<KnowledgeHit[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null)
  const [category, setCategory] = useState<string>('')

  const reload = useCallback(async () => {
    setDocs(await api.kbList())
  }, [])

  useEffect(() => {
    void reload()
    const off = api.on('kb:changed', () => {
      void reload()
    })
    return () => off()
  }, [reload])

  useEffect(() => {
    if (!query.trim()) {
      setHits([])
      return
    }
    const t = window.setTimeout(() => {
      void api.kbSearch(query, 8, category || undefined).then(setHits)
    }, 220)
    return () => window.clearTimeout(t)
  }, [query, category])

  const categories = Array.from(new Set(docs.map((d) => d.category).filter(Boolean)))
  const shown = hits.length ? hits.map((h) => h.doc) : docs

  const generate = async (doc: KnowledgeDoc) => {
    const prompt = `请基于下面这份我的个人资料，生成一段可以直接在面试中说出来的回答。
要求：口语化、第一人称、控制在 60-90 秒能说完的长度；资料里用 {{}} 占位的部分，用方括号标注需要我补充。
如果资料不足以支撑，就给出结构骨架并标注需要补充的信息。

资料标题：${doc.title}
分类：${doc.category}

${doc.content}`
    await api.llmAsk(prompt, [])
    toast('已提交生成，切到「对话」查看结果', 'info')
  }

  return (
    <div className="body">
      <div className="panel tight" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="row" style={{ gap: 6 }}>
          <input
            className="input"
            placeholder="搜索知识库（关键词检索，回车立即搜索）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn sm ghost" onClick={() => void reload()} title="重新加载">
            ⟳
          </button>
        </div>
        <div className="row wrap" style={{ gap: 5, marginTop: 7 }}>
          <span className={`pill clickable ${!category ? 'ok' : ''}`} onClick={() => setCategory('')}>
            全部
          </span>
          {categories.map((c) => (
            <span key={c} className={`pill clickable ${category === c ? 'ok' : ''}`} onClick={() => setCategory(c)}>
              {c}
            </span>
          ))}
        </div>
      </div>

      <div className="panel scroll" style={{ flex: 1, minHeight: 0 }}>
        <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
          <button
            className="btn sm"
            onClick={async () => {
              const name = window.prompt('新文档名称（.md）')
              if (!name) return
              const cat = window.prompt('分类', '技术八股') ?? '未分类'
              const d = await api.kbCreate(name, cat)
              if (d) {
                toast('已创建，文件变更会自动加载', 'info')
                await reload()
              } else toast('创建失败（可能已存在）', 'error')
            }}
          >
            + 新建文档
          </button>
          <button className="btn sm ghost" onClick={() => void api.kbOpenDir()}>
            打开目录（用外部编辑器修改）
          </button>
          <button
            className="btn sm ghost"
            title="通过系统选择框切换知识库目录，避免手敲路径写到不该写的地方"
            onClick={async () => {
              const res = await api.kbPickDir()
              if (!res) return
              if ('error' in res) {
                toast(res.error, 'error')
                return
              }
              toast('已切换知识库目录', 'info')
              // 主进程切换目录后会 reload 并广播 kb:changed，上面的监听会拉新列表
              await reload()
            }}
          >
            更改目录…
          </button>
          <span className="muted">共 {docs.length} 篇 · 改动自动热加载</span>
        </div>

        {shown.map((doc) => {
          const hit = hits.find((h) => h.doc.id === doc.id)
          const open = openId === doc.id
          return (
            <div className="card" key={doc.id}>
              <div className="card-head" onClick={() => setOpenId(open ? null : doc.id)} style={{ cursor: 'pointer' }}>
                <div style={{ flex: 1 }}>
                  <div className="card-title">{doc.title}</div>
                  <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
                    <span className="pill">{doc.category}</span>
                    {doc.tags.map((t) => (
                      <span key={t} className="pill">
                        #{t}
                      </span>
                    ))}
                    {hit && <span className="pill ok">匹配度 {hit.score.toFixed(1)}</span>}
                  </div>
                </div>
                <span className="muted">{open ? '收起' : '展开'}</span>
              </div>

              {open && (
                <>
                  <div className="divider" />
                  {editing?.id === doc.id ? (
                    <>
                      <textarea
                        className="input editor"
                        value={editing.content}
                        onChange={(e) => setEditing({ id: doc.id, content: e.target.value })}
                      />
                      <div className="row" style={{ gap: 6, marginTop: 7 }}>
                        <button
                          className="btn sm primary"
                          onClick={async () => {
                            await api.kbSave(doc.id, editing.content)
                            setEditing(null)
                            toast('已保存（含 frontmatter）', 'info')
                            await reload()
                          }}
                        >
                          保存
                        </button>
                        <button className="btn sm ghost" onClick={() => setEditing(null)}>
                          取消
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      {hit?.snippet && !open && <div className="card-body">{hit.snippet}</div>}
                      <div style={{ maxHeight: 320, overflowY: 'auto', marginTop: 6 }}>
                        <Markdown text={doc.content} />
                      </div>
                      <div className="row wrap" style={{ gap: 6, marginTop: 9 }}>
                        <button className="btn sm primary" onClick={() => void generate(doc)}>
                          一键生成回答
                        </button>
                        <button
                          className="btn sm ghost"
                          onClick={async () => {
                            const full = await api.kbGet(doc.id)
                            setEditing({ id: doc.id, content: rawOf(full) })
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className="btn sm danger"
                          onClick={async () => {
                            if (!window.confirm(`确定删除《${doc.title}》？`)) return
                            await api.kbDelete(doc.id)
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

        {!shown.length && <div className="muted">还没有知识库文档，点「新建文档」或打开目录添加 Markdown。</div>}
      </div>
    </div>
  )
}

function rawOf(doc?: KnowledgeDoc): string {
  if (!doc) return ''
  const fm = `---\ntitle: ${doc.title}\ncategory: ${doc.category}\ntags: [${doc.tags.join(', ')}]\n---\n\n`
  return fm + doc.content
}
