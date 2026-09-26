'use strict'

/**
 * 配额：**所有判定都在这里、都在服务端**。
 *
 * 客户端显示的"剩余额度"只是缓存，任何时候都可以被伪造；
 * 真正决定放不放行的只有本模块。这是整个云端模式的安全底线 ——
 * 一旦放行判断回到客户端，就等于没有配额。
 */

const db = require('./db')
const { PLANS } = require('./env')

/** 当前计费周期标识：免费额度是 lifetime（永不清零），付费额度按月重置 */
function currentPeriod(plan) {
  if (plan.period !== 'monthly') return 'lifetime'
  const now = new Date()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${now.getFullYear()}-${m}`
}

/** 距本期重置还有多久（毫秒）；lifetime 返回 null */
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
 * 过期后**回落到免费额度**（而不是直接封禁），这样用户至少还能看到产品、
 * 也才知道自己该续费。
 */
function entitlement(user) {
  const paidActive =
    user.plan && user.plan !== 'free' && user.plan_expires_at && user.plan_expires_at > Date.now()
  const plan = PLANS[paidActive ? user.plan : 'free'] || PLANS.free
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
    planExpiresAt: paidActive ? user.plan_expires_at : null,
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
    return {
      ok: false,
      reason: 'asr_quota_exhausted',
      message:
        ent.paidActive
          ? `本月语音额度已用完（${ent.asr.limit / 3600} 小时），${resetText(ent.resetInMs)}后重置`
          : `免费语音额度已用完（${Math.round(ent.asr.limit / 60)} 分钟），兑换或开通会员可继续使用`
    }
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
    return {
      ok: false,
      reason: 'llm_quota_exhausted',
      message: ent.paidActive
        ? `本月提问次数已用完（${ent.llm.limit} 次），${resetText(ent.resetInMs)}后重置`
        : `免费提问次数已用完（${ent.llm.limit} 次），兑换或开通会员可继续使用`
    }
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

/** 供 /api/me 展示（`entitlement` 已经把过期会员回落成免费了，这里直接取用即可） */
function snapshot(user) {
  const ent = entitlement(user)
  return {
    account: user.account,
    plan: ent.plan.id,
    planName: ent.plan.name,
    paidActive: ent.paidActive,
    planExpiresAt: ent.planExpiresAt,
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
