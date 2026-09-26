import { useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../context'

/**
 * 服务器（网关）地址。
 *
 * 登录页与「账号」设置页**共用同一个组件**，这不是偷懒：
 * 第一次在一台新机器上打开时还没登录，如果只有设置页能改地址，
 * 用户会永远卡在"连不上默认的 127.0.0.1"那一步。
 *
 * 两个刻意的实现细节：
 * - 写入时机是 **blur / 回车**而不是 onChange。每个字符都 `patchSettings` 会触发一次
 *   `settings:changed` 广播，输入框会在重渲染里卡顿，还容易吞字符。
 * - 显示的是主进程**解析后**的地址（留空时是默认网关），而不是配置里那个空串 ——
 *   否则用户看到空框会以为"没配"，实际却在连 127.0.0.1:8787。
 */
export function GatewayField({ collapsible = false }: { collapsible?: boolean }) {
  const { settings, patchCloud, toast } = useApp()
  const resolved = settings?.cloud?.baseURL ?? ''

  const [open, setOpen] = useState(!collapsible)
  const [value, setValue] = useState(resolved)
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [busy, setBusy] = useState(false)

  // 外部改了地址（换了网关、被安装包预置）时同步回输入框
  useEffect(() => {
    setValue(resolved)
  }, [resolved])

  const save = async () => {
    const v = value.trim().replace(/\/+$/, '')
    setValue(v)
    if (v === resolved) return
    await patchCloud({ baseURL: v })
    setStatus(null)
  }

  const ping = async () => {
    setBusy(true)
    try {
      await save()
      const r = await api.cloudPing()
      setStatus(r)
      if (!r.ok) toast(r.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  if (collapsible && !open) {
    return (
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 6 }}>
        <button className="btn sm ghost" onClick={() => setOpen(true)}>
          服务器地址
        </button>
      </div>
    )
  }

  return (
    <div className="field">
      {collapsible && (
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <label>服务器地址</label>
          <button className="btn sm ghost" onClick={() => setOpen(false)}>
            收起
          </button>
        </div>
      )}
      {!collapsible && <label>服务器地址</label>}
      <div className="row" style={{ gap: 6 }}>
        <input
          className="input"
          value={value}
          placeholder="http://127.0.0.1:8787"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void ping()
          }}
        />
        <button className="btn sm" disabled={busy} onClick={() => void ping()}>
          {busy ? '检测中…' : '检测'}
        </button>
      </div>
      <div className="hint">
        填到域名或 <code>IP:端口</code> 即可，<b>不要</b>带 <code>/v1</code> 后缀。留空则用默认的本机地址。
      </div>
      {status && (
        <div className={`pill ${status.ok ? 'ok' : 'err'}`} style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>
          {status.message}
        </div>
      )}
    </div>
  )
}
