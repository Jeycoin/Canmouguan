'use strict'

/**
 * 配额：**所有判定都在这里、都在服务端**。
 *
 * 客户端显示的"剩余额度"只是缓存，任何时候都可以被伪造；
 * 真正决定放不放行的只有本模块。这是整个云端模式的安全底线 ——
 * 一旦放行判断回到客户端，就等于没有配额。
 *
 * ⚠️ 本产品**没有免费额度**：没开通 / 已到期的账号落到的额度是 0，任何消耗性接口都会被拒。
 * 所以"被拒"有三种语义，必须分开说清楚（见 `denyText`），否则用户只看到"用不了"，
 * 却不知道下一步该做什么。
 */

const db = require('./db')
const { PLANS } = require('./env')

/**
 * 从未开通过的状态集合。
 * `'free'` 是早期版本的免费套餐 id —— 免费套餐已经取消，它现在**等价于"没开通"**。
 * 留在集合里是为了让升级前的老账号（plan 列还写着 'free'）平滑落到 none，而不是拿到 undefined。
 */
const NEVER_ACTIVATED = new Set([undefined, null, '', 'none', 'free'])

/** 当前计费周期标识：pro 按月重置；none 没有周期可言 */
function currentPeriod(plan) {
  if (plan.period !== 'monthly') return plan.period
  const now = new Date()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${now.getFullYear()}-${m}`
}

/** 距本期重置还有多久（毫秒）；非按月套餐返回 null */
function msUntilReset(plan) {
  if (plan.period !== 'monthly') return null
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0)
  return next.getTime() - now.getTime()
}

/**
 * 解析一个用户**此刻**实际享有的权益。
 *
 * 关键点：不信任 `user.plan` 本身 —— 会员可能已经过期。
 *
 * ⚠️ 过期后**不再回落到任何免费额度**（产品已取消免费体验），而是回落到 `PLANS.none`。
 * 但"曾经开通过"这件事会记在 `expired` 上：对用户来说"续费"和"首次开通"
 * 是完全不同的两件事，文案必须能区分，否则到期的人会以为自己的号坏了。
 */
function entitlement(user) {
  const everActivated = !NEVER_ACTIVATED.has(user.plan)
  const paidActive = !!(everActivated && user.plan_expires_at && user.plan_expires_at > Date.now())
  const plan = (paidActive ? PLANS[user.plan] : PLANS.none) || PLANS.none
  const period = currentPeriod(plan)
  const usage = db.getUsage(user.id, period)

  const asrUsed = Math.max(0, Number(usage.asr_seconds) || 0)
  const llmUsed = Math.max(0, Number(usage.llm_calls) || 0)
  const llmTokens = Math.max(0, Number(usage.llm_tokens) || 0)

  return {
    plan,
    period,
    /** 会员是否仍在有效期内 */
    paidActive,
    /** 开通过、但已经过期（用于把"请续费"和"请先开通"分开） */
    expired: !paidActive && everActivated,
    planExpiresAt: paidActive ? user.plan_expires_at : null,
    /** 已过期时的到期时间戳，**仅用于文案**（planExpiresAt 在过期后按既有语义是 null） */
    expiredAt: !paidActive && everActivated ? user.plan_expires_at : null,
    asr: {
      used: Math.round(asrUsed),
      limit: plan.asrSeconds,
      remaining: Math.max(0, Math.round(plan.asrSeconds - asrUsed))
    },
    llm: {
      used: llmUsed,
      limit: plan.llmCalls,
      remaining: Math.max(0, plan.llmCalls - llmUsed),
      /** 仅统计用，不参与限额判定 —— 计费单位是"次"，用户更容易理解 */
      tokens: llmTokens
    },
    resetInMs: msUntilReset(plan)
  }
}

function fmtDay(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 把秒数说成人话。
 * 不要偷懒写死 `${limit / 3600} 小时` —— 额度一旦配得比 1 小时还小，
 * 用户会看到"本月语音额度已用完（0.0008 小时）"这种东西。
 */
function fmtLimit(seconds) {
  const s = Math.max(0, Number(seconds) || 0)
  if (s >= 3600) return `${Math.round((s / 3600) * 10) / 10} 小时`
  if (s >= 60) return `${Math.round(s / 60)} 分钟`
  return `${Math.round(s)} 秒`
}

/**
 * 被拒时给用户看的文案。三种语义必须分开：
 *
 *   1. 会员有效但额度用完 → 还能等重置（所以要说清什么时候重置）
 *   2. 开通过但已到期     → 要续费（所以要说清到期日）
 *   3. 从未开通           → 要先去买/兑换
 *
 * 只说"额度已用完"是最坏的做法：到期和没开通的人都会以为 "我的额度用光了"，
 * 而实际上他们连额度都还没有。
 *
 * 注意这里**只改文案，不改 reason**：reason 是机器可读的契约，
 * 客户端和自测都在依赖它（`asr_quota_exhausted` / `llm_quota_exhausted`）。
 */
function denyText(ent, kind) {
  const label = kind === 'asr' ? '语音' : '提问'
  if (ent.paidActive) {
    const limit = kind === 'asr' ? fmtLimit(ent.asr.limit) : `${ent.llm.limit} 次`
    const reset = resetText(ent.resetInMs)
    return `本月${label}额度已用完（${limit}）${reset ? `，${reset}后重置` : ''}`
  }
  if (ent.expired) {
    const day = fmtDay(ent.expiredAt)
    return `会员${day ? `已于 ${day} ` : '已'}到期，兑换新的兑换码即可继续使用`
  }
  return '尚未开通会员，兑换兑换码后即可使用'
}

/**
 * 额度检查。**不预扣**，只判断"当前是否还有剩余"。
 *
 * 为什么不预扣：ASR 是长连接，无法在建立时就确定会占用多少秒。
 * 做法是连接前查一次（剩 0 就拒绝），运行中按实际用量累加，
 * 一旦累计超过上限**立刻断开**。这样既不会少算，也不会因为估错而误拒。
 */
function checkAsr(user, neededSeconds = 0) {
  const ent = entitlement(user)
  if (ent.asr.remaining <= 0) {
    return { ok: false, reason: 'asr_quota_exhausted', message: denyText(ent, 'asr') }
  }
  if (neededSeconds > ent.asr.remaining) {
    return {
      ok: false,
      reason: 'asr_quota_insufficient',
      message: `语音额度不足：本次约需 ${Math.ceil(neededSeconds)} 秒，剩余 ${ent.asr.remaining} 秒`
    }
  }
  return { ok: true, entitlement: ent }
}

function checkLlm(user) {
  const ent = entitlement(user)
  if (ent.llm.remaining <= 0) {
    return { ok: false, reason: 'llm_quota_exhausted', message: denyText(ent, 'llm') }
  }
  return { ok: true, entitlement: ent }
}

function resetText(ms) {
  if (ms == null) return ''
  const days = Math.floor(ms / 86400000)
  if (days >= 1) return `${days} 天`
  const hours = Math.floor(ms / 3600000)
  if (hours >= 1) return `${hours} 小时`
  return `${Math.max(1, Math.floor(ms / 60000))} 分钟`
}

/** 记账：ASR 秒数 */
function chargeAsr(user, seconds) {
  if (!(seconds > 0)) return
  const ent = entitlement(user)
  db.addAsrSeconds(user.id, ent.period, seconds)
}

/**
 * 记账：一次 LLM 调用。
 *
 * 刻意做成"先记次数、后补 tokens"两步，因为**流式的 token 数要等流结束才知道**，
 * 而次数必须在上游返回 200 的那一刻就记下 —— 否则并发打进来的请求会在
 * "还没记账"的窗口里全部放行，配额形同虚设。
 */
function chargeLlm(user, tokens = 0) {
  const ent = entitlement(user)
  db.addLlmUsage(user.id, ent.period, 1, tokens)
}

/** 仅补记 tokens（统计用，不参与限额判定），用于流式结束后回填真实用量 */
function chargeLlmTokens(user, tokens = 0) {
  if (!(tokens > 0)) return
  const ent = entitlement(user)
  db.addLlmUsage(user.id, ent.period, 0, tokens)
}

/* --------------------- 实时连接的并发控制（进程内） --------------------- */

/**
 * 只在内存里记，不落库：进程重启后所有连接本来就断了，
 * 落库反而会在异常退出时留下永远释放不掉的"幽灵连接"，把用户锁死。
 */
const liveRealtime = new Map() // userId -> count

function acquireRealtimeSlot(user) {
  const ent = entitlement(user)
  const limit = ent.plan.concurrentRealtime
  /* 没有会员时 limit 是 0。虽然调用方（relay-asr）已经先过了一遍 checkAsr，
     但这里必须自己给出可读的话 —— 否则漏出来的会是"同时进行的实时转写已达上限（0 路）"，
     用户完全不知道自己做错了什么。 */
  if (limit <= 0) {
    return { ok: false, reason: 'asr_quota_exhausted', message: denyText(ent, 'asr') }
  }
  const used = liveRealtime.get(user.id) || 0
  if (used >= limit) {
    return {
      ok: false,
      reason: 'too_many_realtime',
      message: `同时进行的实时转写已达上限（${limit} 路），请先停止当前录音`
    }
  }
  liveRealtime.set(user.id, used + 1)
  return { ok: true, entitlement: ent }
}

function releaseRealtimeSlot(userId) {
  const used = liveRealtime.get(userId) || 0
  if (used <= 1) liveRealtime.delete(userId)
  else liveRealtime.set(userId, used - 1)
}

/**
 * 供 /api/me 展示。
 * 直接取 `entitlement` 的结果 —— 它已经把过期会员落成 `PLANS.none` 了，
 * 这里不要再去读 `user.plan`（那会显示出"专业版"，但额度是 0，自相矛盾）。
 */
function snapshot(user) {
  const ent = entitlement(user)
  return {
    account: user.account,
    plan: ent.plan.id,
    planName: ent.plan.name,
    paidActive: ent.paidActive,
    /** 已到期（`paidActive` 为 false 时不区分"从没开通过"和"到期了"，这里补上区别） */
    expired: ent.expired,
    planExpiresAt: ent.planExpiresAt,
    /** 已到期时的到期时间戳，**只用于展示**（旧客户端不认识它，会忽略） */
    expiredAt: ent.expiredAt,
    asr: ent.asr,
    llm: ent.llm,
    resetInMs: ent.resetInMs
  }
}

module.exports = {
  entitlement,
  checkAsr,
  checkLlm,
  chargeAsr,
  chargeLlm,
  chargeLlmTokens,
  acquireRealtimeSlot,
  releaseRealtimeSlot,
  snapshot
}
