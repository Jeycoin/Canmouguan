import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../context'

/**
 * 购买指引。
 *
 * 这套东西的形态是**兑换码**：客户端永远不接支付，只认码。
 * 所以这里的职责只有一件事 —— 让用户知道"去哪付钱、怎么拿到码"。
 *
 * ## 为什么价格与购买链接来自服务端
 *
 * 改价、换渠道、换客服微信一定会发生，而客户端**没有自动更新通道**。
 * 写死在客户端等于"每改一次价格就要所有老用户手动重下"。
 * 网关的 `/api/plans` 是公开接口（免登录），改完立即全量生效。
 *
 * ## 为什么登录页也要放
 *
 * 想买的人**绝大多数还没有账号** —— 只把入口放在"设置 → 账号"里，
 * 等于让最该看到它的人看不到。所以这里导出两档：完整卡片 + 一行提示。
 *
 * 刻意**不做二维码渲染**：那要引一个依赖（`server/` 才 1 个依赖，客户端也不该为它破例），
 * 而"点一下用系统浏览器打开购买页"已经解决了同一个问题。
 */

export interface StorePlan {
  kind: string
  name: string
  plan: string
  days: number
  price: number | null
}

export interface StoreDetails {
  purchaseUrl: string
  contactWechat: string
  contactQq: string
  contactEmail: string
  note: string
}

export interface StoreInfo {
  currency: string
  plans: StorePlan[]
  store: StoreDetails
  live: boolean
}

const EMPTY: StoreInfo = {
  currency: 'CNY',
  plans: [],
  store: { purchaseUrl: '', contactWechat: '', contactQq: '', contactEmail: '', note: '' },
  live: false
}

/**
 * 模块级缓存：登录页和账号页会各渲染一次，不能各拉一遍。
 * 拉失败也缓存（否则每次切 tab 都重试一遍，网关不可达时会拖慢界面）。
 */
let cached: StoreInfo | null = null
let inflight: Promise<StoreInfo> | null = null

function fetchStore(): Promise<StoreInfo> {
  if (cached) return Promise.resolve(cached)
  if (inflight) return inflight
  inflight = api
    .cloudPlans()
    .then((r) => {
      cached = r.ok
        ? {
            currency: r.currency || 'CNY',
            plans: r.plans || [],
            store: { ...EMPTY.store, ...(r.store || {}) },
            live: Boolean(r.live)
          }
        : EMPTY
      return cached
    })
    .catch(() => {
      cached = EMPTY
      return cached
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 供两个出口复用；`refresh` 会让下一次调用重新拉一遍（网关换了配置时用） */
export function useStoreInfo(): { info: StoreInfo; loading: boolean; refresh: () => void } {
  const [info, setInfo] = useState<StoreInfo>(cached ?? EMPTY)
  const [loading, setLoading] = useState(!cached)

  useEffect(() => {
    let alive = true
    void fetchStore().then((v) => {
      if (!alive) return
      setInfo(v)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [])

  const refresh = useCallback(() => {
    cached = null
    setLoading(true)
    void fetchStore().then(setInfo)
  }, [])

  return { info, loading, refresh }
}

function hasChannel(store: StoreDetails): boolean {
  return Boolean(store.purchaseUrl || store.contactWechat || store.contactQq || store.contactEmail)
}

/**
 * 复制到剪贴板。
 *
 * `navigator.clipboard` 在部分环境下需要权限（本项目的权限处理器会拒绝未知权限），
 * 所以保留 `execCommand` 这条老路 —— 与其让按钮点了没反应，不如诚实地退一步。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* 退到下面的兼容路径 */
  }
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}

/** 一行联系方式：只读输入框（点一下自动全选）+ 复制按钮 */
function ContactRow({ label, value }: { label: string; value: string }) {
  const { toast } = useApp()
  if (!value) return null
  return (
    <div className="field" style={{ marginBottom: 6 }}>
      <label>{label}</label>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="input"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          style={{ flex: 1 }}
        />
        <button
          className="btn sm ghost"
          onClick={() => {
            void copyText(value).then((ok) => toast(ok ? '已复制' : '复制失败，请手动选中后按 Ctrl+C', ok ? 'info' : 'error'))
          }}
        >
          复制
        </button>
      </div>
    </div>
  )
}

/** 套餐价目表。价格为 0 或 null 的显示成"免费体验"，避免出现"¥0"这种看着像 bug 的东西。 */
function PlanList({ info }: { info: StoreInfo }) {
  if (!info.plans.length) return null
  return (
    <div className="field">
      <label>可选套餐</label>
      {info.plans.map((p) => (
        <div key={p.kind} className="row" style={{ gap: 6, marginBottom: 4, alignItems: 'center' }}>
          <span className="pill" style={{ minWidth: 96 }}>
            {p.name}
          </span>
          <span className="hint" style={{ margin: 0 }}>
            {p.days} 天
          </span>
          <div style={{ flex: 1 }} />
          <b style={{ color: 'var(--accent)' }}>{p.price ? `¥${p.price}` : '免费体验'}</b>
        </div>
      ))}
    </div>
  )
}

/** 账号页用的完整卡片 */
export function PurchaseCard() {
  const { info, loading } = useStoreInfo()
  const { store } = info

  return (
    <>
      <div className="section-title">如何购买</div>

      {loading && <div className="hint muted">正在获取购买方式…</div>}

      {!loading && !hasChannel(store) && (
        <div className="field">
          <span className="pill warn">暂无购买渠道</span>
          <div className="hint" style={{ marginTop: 6 }}>
            服务端还没有配置购买方式。如果你是运营者：请在网关的 <code>.env</code> 里设置{' '}
            <code>CMG_STORE_URL</code>（或 <code>CMG_STORE_WECHAT</code>），重启后这里会自动出现。
          </div>
        </div>
      )}

      {!loading && hasChannel(store) && (
        <>
          <PlanList info={info} />

          {store.purchaseUrl && (
            <div className="field">
              <label>购买地址</label>
              {/* target="_blank" 会被主进程的 windowOpenHandler 接管，
                  交给系统浏览器打开 —— 不在应用窗口里加载外部页面。 */}
              <a
                className="btn sm primary"
                href={store.purchaseUrl}
                target="_blank"
                rel="noreferrer"
                style={{ width: '100%', justifyContent: 'center' }}
              >
                打开购买页
              </a>
              <div className="hint" style={{ wordBreak: 'break-all' }}>{store.purchaseUrl}</div>
            </div>
          )}

          <ContactRow label="微信" value={store.contactWechat} />
          <ContactRow label="QQ" value={store.contactQq} />
          <ContactRow label="邮箱" value={store.contactEmail} />

          {store.note && <div className="hint">{store.note}</div>}

          <div className="hint" style={{ marginTop: 4 }}>
            付款后你会拿到一个兑换码（形如 <code>CMG-XXXXX-XXXXX-XXXXX</code>），
            在下面「兑换码」处输入即可开通。
          </div>
        </>
      )}
    </>
  )
}

/** 登录页用的一行提示：只给"怎么买"，不铺开价目表 */
export function PurchaseHint() {
  const { info, loading } = useStoreInfo()
  const { store } = info
  if (loading || !hasChannel(store)) return null

  const cheapest = info.plans.filter((p) => p.price).sort((a, b) => (a.price || 0) - (b.price || 0))[0]

  return (
    <div className="hint" style={{ marginTop: 9 }}>
      还没有兑换码？
      {store.purchaseUrl ? (
        <>
          {' '}
          <a href={store.purchaseUrl} target="_blank" rel="noreferrer">
            点此购买
          </a>
        </>
      ) : null}
      {!store.purchaseUrl && store.contactWechat ? ` 添加微信 ${store.contactWechat} 购买` : null}
      {!store.purchaseUrl && !store.contactWechat && store.contactQq ? ` 联系 QQ ${store.contactQq} 购买` : null}
      {cheapest?.price ? `（${cheapest.name} ¥${cheapest.price} 起）` : ''}
      ，拿到码后在注册时填入即可直接开通。
    </div>
  )
}
