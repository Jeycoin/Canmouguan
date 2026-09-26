import { useCallback, useState } from 'react'
import { api } from '../api'
import type { CloudQuota } from '../api'
import { useApp } from '../context'
import { GatewayField } from './GatewayField'
import { PurchaseCard } from './PurchaseCard'

/**
 * 账号面板（设置里的「账号」页）。
 *
 * 登录/注册不在这里 —— 那是进入应用前的闸门（`LoginGate`）。
 * 这一屏只管登录之后的事：看额度、兑换、退出。
 *
 * ⚠️ 这里渲染的额度**只是缓存，可以伪造**。它用于让用户知道还剩多少，
 * 真正的放行判断全在服务端（`server/lib/quota.js`）。
 * 所以不要在这上面加任何"余额不足就禁用按钮"的逻辑 —— 那只是 UX 提示，
 * 一旦被当成权限判断，就等于把配额交给了客户端。
 */

/* ------------------------------ 显示格式化 ------------------------------ */

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0))
  if (s <= 0) return '0 分钟'
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  if (h && m) return `${h} 小时 ${m} 分钟`
  if (h) return `${h} 小时`
  if (m) return `${m} 分钟`
  return `${s} 秒`
}

function fmtDate(ts?: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 免费额度的周期是 lifetime，永远不会重置，所以这里要能表达"无重置" */
function fmtReset(ms?: number | null): string {
  if (ms == null) return ''
  const days = Math.floor(ms / 86400000)
  if (days >= 1) return `${days} 天后重置`
  const hours = Math.floor(ms / 3600000)
  if (hours >= 1) return `${hours} 小时后重置`
  return `${Math.max(1, Math.floor(ms / 60000))} 分钟后重置`
}

function QuotaBar({ label, used, limit, render }: { label: string; used: number; limit: number; render: (v: number) => string }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  const tone = pct >= 100 ? 'var(--err)' : pct >= 80 ? 'var(--warn)' : 'var(--accent)'
  return (
    <div className="field">
      <label>{label}</label>
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: 'var(--border)',
          overflow: 'hidden',
          margin: '5px 0 6px'
        }}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: tone, transition: 'width .25s' }} />
      </div>
      <div className="hint">
        已用 {render(used)} / {render(limit)}，剩余 <b>{render(Math.max(0, limit - used))}</b>
      </div>
    </div>
  )
}

/* ------------------------------ 额度概览卡 ------------------------------ */

export function CloudQuotaCard({ me }: { me: CloudQuota }) {
  return (
    <>
      <div className="row wrap" style={{ gap: 6, marginBottom: 4 }}>
        <span className={`pill ${me.paidActive ? 'ok' : ''}`}>{me.planName}</span>
        <span className="pill">{me.account}</span>
        {me.paidActive ? (
          <span className="pill">有效期至 {fmtDate(me.planExpiresAt)}</span>
        ) : (
          <span className="pill warn">免费额度</span>
        )}
      </div>
      <QuotaBar
        label="语音转写额度"
        used={me.asr.used}
        limit={me.asr.limit}
        render={fmtDuration}
      />
      {!me.paidActive && <div className="hint" style={{ marginTop: -4, marginBottom: 8 }}>免费额度为一次性，用完为止。</div>}
      <QuotaBar
        label="提问次数"
        used={me.llm.used}
        limit={me.llm.limit}
        render={(v) => `${Math.round(v)} 次`}
      />
      {fmtReset(me.resetInMs) && <div className="hint">{fmtReset(me.resetInMs)}</div>}
    </>
  )
}

/* --------------------------------- 主体 --------------------------------- */

export function CloudPanel() {
  const { settings, reloadSettings, toast } = useApp()
  const cloud = settings?.cloud
  const loggedIn = Boolean(cloud?.hasToken)
  const me = cloud?.lastMe ?? null

  const [busy, setBusy] = useState<string | null>(null)
  const [redeemCode, setRedeemCode] = useState('')

  const run = useCallback(
    async (key: string, fn: () => Promise<string | void>) => {
      setBusy(key)
      try {
        const msg = await fn()
        if (msg) toast(msg, 'info')
      } catch (err) {
        toast((err as Error).message, 'error')
      } finally {
        setBusy(null)
      }
    },
    [toast]
  )

  const doRedeem = () =>
    run('redeem', async () => {
      const code = redeemCode.trim()
      if (!code) throw new Error('请输入兑换码')
      const r = await api.cloudRedeem(code)
      if (!r.ok) throw new Error(r.message ?? '兑换失败')
      setRedeemCode('')
      await reloadSettings()
      return r.message ?? '兑换成功'
    })

  const doRefresh = () =>
    run('refresh', async () => {
      const r = await api.cloudRefresh()
      if (!r.ok) throw new Error(r.message ?? '同步失败')
      await reloadSettings()
      toast('额度已同步', 'info')
    })

  const doLogout = () =>
    run('logout', async () => {
      await api.cloudLogout()
      await reloadSettings()
      toast('已退出登录', 'info')
    })

  if (!cloud) return <div className="panel muted">加载中…</div>

  return (
    <>
      <div className="section-title">账号</div>

      {!loggedIn && (
        <div className="field">
          <span className="pill warn">尚未登录</span>
          <div className="hint" style={{ marginTop: 6 }}>
            登录凭证已失效或已被清除，重新登录后即可继续使用。
          </div>
        </div>
      )}

      {me && <CloudQuotaCard me={me} />}

      {/* 「退出登录」必须**始终可达**：它是从"凭据坏了"回到登录页的唯一出口。 */}
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        {me && (
          <button className="btn sm ghost" disabled={busy === 'refresh'} onClick={() => void doRefresh()}>
            {busy === 'refresh' ? '同步中…' : '刷新额度'}
          </button>
        )}
        <button className="btn sm danger" disabled={busy === 'logout'} onClick={() => void doLogout()}>
          {loggedIn ? '退出登录' : '回到登录页'}
        </button>
      </div>

      {/* 购买 → 兑换 紧挨着放：用户的动作顺序就是"先去买、拿到码、回来兑"。
          位置在兑换码**上面**，因为没购买渠道的人根本不知道该去哪付钱。 */}
      <PurchaseCard />

      {me && (
        <>
          <div className="section-title">兑换码</div>
          <div className="field">
            <div className="row" style={{ gap: 6 }}>
              <input
                className="input"
                value={redeemCode}
                placeholder="CMG-XXXXX-XXXXX-XXXXX"
                onChange={(e) => setRedeemCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doRedeem()
                }}
              />
              <button className="btn sm primary" disabled={busy === 'redeem'} onClick={() => void doRedeem()}>
                {busy === 'redeem' ? '兑换中…' : '兑换'}
              </button>
            </div>
            <div className="hint">
              兑换成功后会员立即生效；<strong>已是会员则会在原到期时间上顺延</strong>，提前续费不会吃亏。
            </div>
            <div className="hint">
              每个兑换码只能使用一次。用完需要<strong>再买一个</strong> —— 兑换码不支持自动续费，
              到期前记得自行续期。
            </div>
          </div>
        </>
      )}

      <div className="divider" />
      <GatewayField />

      <div className="hint muted" style={{ marginTop: 6 }}>
        上游密钥（语音 / 大模型）只保存在服务端，本机不保存、也无法填写。
      </div>
    </>
  )
}
