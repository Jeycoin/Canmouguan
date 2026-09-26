import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../context'
import { GatewayField } from './GatewayField'
import { PurchaseHint } from './PurchaseCard'

/**
 * 登录闸门：**未登录时整个应用只有这一屏**。
 *
 * 为什么必须是闸门而不是"设置里一个可选项"：
 * 上游密钥只存在于自建网关，客户端没有任何可用的离线路径 ——
 * 没登录就发不出语音、也问不了 AI。与其进到主界面里到处弹"未登录"，
 * 不如在门口说清楚。这也是"完全屏蔽自带 Key"在界面上的最终体现。
 *
 * 三件事都在这一屏完成：登录 / 注册 / 换服务器地址。
 * 兑换码放在**注册时**填（登录后也能在「设置 → 账号」里兑），
 * 因为拿到兑换码的人多半还没账号。
 */

type Mode = 'login' | 'register'
type Method = 'password' | 'phone-code'

const PHONE_RE = /^1[3-9]\d{9}$/

export function LoginGate() {
  const { reloadSettings, toast, settings } = useApp()

  const [mode, setMode] = useState<Mode>('login')
  const [method, setMethod] = useState<Method>('password')

  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [phone, setPhone] = useState('')
  const [smsCode, setSmsCode] = useState('')
  const [invite, setInvite] = useState('')

  const [busy, setBusy] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const [smsReady, setSmsReady] = useState<boolean | null>(null)
  const [gatewayNote, setGatewayNote] = useState<string | null>(null)

  /* 进这一屏就先探一次网关：连不上/短信没配 都要现在说清楚，
     而不是等用户填完表单点下去才报错。 */
  useEffect(() => {
    let alive = true
    void api.cloudPing().then((r) => {
      if (!alive) return
      setSmsReady(r.smsReady ?? null)
      setGatewayNote(r.ok ? null : r.message)
    })
    return () => {
      alive = false
    }
  }, [])

  /* 重发倒计时。用的是服务端给的 resendAfterMs，不自己编一个秒数 ——
     两边不一致用户就会遇到"按钮亮了但服务端还在拒绝"。 */
  const cooling = cooldown > 0
  useEffect(() => {
    if (!cooling) return
    const t = window.setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000)
    return () => window.clearInterval(t)
  }, [cooling])

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

  const sendCode = (purpose: 'login' | 'register') =>
    run('sms', async () => {
      const p = phone.trim()
      if (!PHONE_RE.test(p)) throw new Error('请输入 11 位手机号')
      const r = await api.cloudSmsSend(p, purpose)
      if (!r.ok) throw new Error(r.message ?? '验证码发送失败')
      setCooldown(Math.ceil((r.resendAfterMs ?? 60000) / 1000))
      // 本机 console 通道时验证码在服务端日志里，得提醒一句，否则用户真的会等短信
      return r.provider === 'console'
        ? `验证码已生成（${r.ttlMinutes ?? 5} 分钟内有效）—— 当前服务端用本机调试通道，验证码打印在网关日志里`
        : `验证码已发送（${r.ttlMinutes ?? 5} 分钟内有效）`
    })

  const doLogin = () =>
    run('submit', async () => {
      const input =
        method === 'phone-code'
          ? { phone: phone.trim(), smsCode: smsCode.trim() }
          : { account: account.trim(), password }
      if (method === 'phone-code') {
        if (!PHONE_RE.test(phone.trim())) throw new Error('请输入 11 位手机号')
        if (!/^\d{6}$/.test(smsCode.trim())) throw new Error('请输入 6 位验证码')
      } else {
        if (!account.trim()) throw new Error('请输入账号或手机号')
        if (!password) throw new Error('请输入密码')
      }
      const r = await api.cloudLogin(input)
      if (!r.ok) throw new Error(r.message ?? '登录失败')
      await reloadSettings()
      return `欢迎回来${r.me?.planName ? `（${r.me.planName}）` : ''}`
    })

  const doRegister = () =>
    run('submit', async () => {
      if (method === 'password') {
        if (!account.trim()) throw new Error('请输入账号')
        if (password.length < 6) throw new Error('密码至少 6 位')
        const r = await api.cloudRegister({
          account: account.trim(),
          password,
          ...(invite.trim() ? { code: invite.trim().toUpperCase() } : {})
        })
        if (!r.ok) throw new Error(r.message ?? '注册失败')
        await reloadSettings()
        return r.warning ?? '注册成功，已登录'
      }
      if (!PHONE_RE.test(phone.trim())) throw new Error('请输入 11 位手机号')
      if (!/^\d{6}$/.test(smsCode.trim())) throw new Error('请输入 6 位验证码')
      if (password.length < 6) throw new Error('请设置至少 6 位密码，之后可用密码或验证码登录')
      const r = await api.cloudRegister({
        phone: phone.trim(),
        smsCode: smsCode.trim(),
        password,
        ...(account.trim() ? { account: account.trim() } : {}),
        ...(invite.trim() ? { code: invite.trim().toUpperCase() } : {})
      })
      if (!r.ok) throw new Error(r.message ?? '注册失败')
      await reloadSettings()
      return r.warning ?? '注册成功，已登录'
    })

  const submit = () => void (mode === 'login' ? doLogin() : doRegister())
  const submitting = busy === 'submit'
  const smsDisabled = busy === 'sms' || cooldown > 0 || smsReady === false

  return (
    <div className="panel scroll" style={{ height: '100%', padding: '14px 14px 18px' }}>
      <div className="section-title" style={{ fontSize: 15 }}>
        参谋官
      </div>
      <div className="hint muted" style={{ marginBottom: 10 }}>
        语音转写与 AI 回答都在服务端完成，登录后即可使用。没有账号？先注册一个。
      </div>

      <div className="row" style={{ gap: 6, marginBottom: 9 }}>
        <button
          className={`btn sm ${mode === 'login' ? 'primary' : 'ghost'}`}
          onClick={() => setMode('login')}
        >
          登录
        </button>
        <button
          className={`btn sm ${mode === 'register' ? 'primary' : 'ghost'}`}
          onClick={() => setMode('register')}
        >
          注册
        </button>
        <div style={{ flex: 1 }} />
        <GatewayField collapsible />
      </div>

      <div className="tabs-inner" style={{ marginBottom: 9 }}>
        <button
          className={`btn sm ${method === 'password' ? 'primary' : 'ghost'}`}
          onClick={() => setMethod('password')}
        >
          {mode === 'login' ? '账号密码' : '账号注册'}
        </button>
        <button
          className={`btn sm ${method === 'phone-code' ? 'primary' : 'ghost'}`}
          onClick={() => setMethod('phone-code')}
        >
          {mode === 'login' ? '手机验证码' : '手机号注册'}
        </button>
      </div>

      {gatewayNote && (
        <div className="field">
          <span className="pill err" style={{ whiteSpace: 'pre-wrap' }}>
            {gatewayNote}
          </span>
        </div>
      )}

      {/* -------- 账号密码：登录用它，注册还是用它 -------- */}
      {method === 'password' && (
        <>
          <div className="field">
            <label>{mode === 'login' ? '账号或手机号' : '账号'}</label>
            <input
              className="input"
              value={account}
              autoComplete="username"
              placeholder={mode === 'login' ? '邮箱 / 手机号 / 自定义账号' : '3–64 位字母、数字或 _ . @ + -'}
              onChange={(e) => setAccount(e.target.value)}
            />
          </div>
          <div className="field">
            <label>密码</label>
            <input
              className="input"
              type="password"
              value={password}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              placeholder="至少 6 位"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
          </div>
        </>
      )}

      {/* -------- 手机：验证码登录 / 手机号注册 -------- */}
      {method === 'phone-code' && (
        <>
          <div className="field">
            <label>手机号</label>
            <div className="row" style={{ gap: 6 }}>
              <input
                className="input"
                value={phone}
                inputMode="numeric"
                placeholder="11 位手机号"
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
              />
              <button
                className="btn sm"
                disabled={smsDisabled}
                onClick={() => void sendCode(mode === 'register' ? 'register' : 'login')}
              >
                {busy === 'sms' ? '发送中…' : cooldown > 0 ? `${cooldown}s` : '获取验证码'}
              </button>
            </div>
            {smsReady === false && (
              <div className="hint">
                服务端短信通道未就绪，暂时拿不到验证码 —— 可先用「账号密码」登录，
                或在服务端配置 <code>CMG_SMS_*</code>。
              </div>
            )}
          </div>
          <div className="field">
            <label>验证码</label>
            <input
              className="input"
              value={smsCode}
              inputMode="numeric"
              placeholder="6 位数字"
              onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
            {mode === 'register' && (
              <div className="hint">
                手机号注册要一并设置密码（上面这个框与登录用的是同一个），之后密码和验证码都能登录。
              </div>
            )}
          </div>
          {mode === 'register' && (
            <div className="field">
              <label>密码</label>
              <input
                className="input"
                type="password"
                value={password}
                autoComplete="new-password"
                placeholder="至少 6 位"
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}
        </>
      )}

      {mode === 'register' && (
        <>
          {method === 'phone-code' && (
            <div className="field">
              <label>登录名（可选）</label>
              <input
                className="input"
                value={account}
                placeholder="留空则直接用手机号当账号"
                onChange={(e) => setAccount(e.target.value)}
              />
            </div>
          )}
          <div className="field">
            <label>兑换码 / 内测邀请码（可选）</label>
            <input
              className="input"
              value={invite}
              placeholder="CMG-XXXXX-XXXXX-XXXXX"
              onChange={(e) => setInvite(e.target.value.toUpperCase())}
            />
            <div className="hint">
              填了会在注册后<strong>直接开通</strong>，省掉登录后再兑一次。内测期可能只对持码用户开放注册。
            </div>
          </div>
        </>
      )}

      <button className="btn primary" style={{ width: '100%', marginTop: 4 }} disabled={submitting} onClick={submit}>
        {submitting ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
      </button>

      {/* 想买的人绝大多数**还没有账号** —— 购买入口必须出现在这一屏，
          只放在"设置 → 账号"里等于让最该看到它的人看不到。 */}
      <PurchaseHint />

      <div className="hint muted" style={{ marginTop: 9 }}>
        服务器地址：{settings?.cloud?.baseURL || '（默认本机）'}
      </div>
    </div>
  )
}
