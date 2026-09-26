'use strict'

/**
 * 发卡平台回调 → 自动发码。
 *
 * ## 为什么是"回调发码"而不是"预先生成一批码填进平台库存"
 *
 * 两种做法都能用，区别在**码在谁手里**：
 *   - 库存模式：码先批量导入平台，平台卖出后把码给买家。你这边零开发，但码在别人库里，
 *     平台跑路/被拖库 = 你的码全泄露，而且你无法知道"卖出去了但没人来兑换"的码去哪了。
 *   - 回调模式（本文件）：**买家付款后你才签发**，码从生成到交付不超过一秒，
 *     库里不存在"一大批发出去还没被用的码"。平台只拿到这一单的码。
 *
 * ## 三条必须守住的东西
 *
 * 1. **默认关闭**：这个端点能在没有任何账号的前提下凭空发会员。token 没配就是 503，
 *    绝不能"没配就当开放"。裸奔等于把免费领会员开放给全网。
 * 2. **幂等**：平台没收到 200 会重试。`(platform, order_id)` 唯一索引由数据库保证，
 *    重复回调**原样返回上次那批码**，绝不重新签发。
 * 3. **不认识的商品要报错，不能落回默认套餐**：落回默认会把"卖 7 天试用"的订单发成
 *    "专业版 1 年"，而且没有任何地方会提示你 —— 只会在对账时发现收入对不上。
 *
 * 注意本模块**不校验金额**：网关不参与收款，平台回调里的金额只是记下来供对账，
 * 拿它当判断依据反而会引入"平台金额字段变了就发不出码"的脆弱性。
 */

const crypto = require('node:crypto')
const db = require('./db')
const redeem = require('./redeem')
const { ok, fail, readJson, clientIp } = require('./http')
const { PAYHOOK, REDEEM_PLANS } = require('./env')

/* ------------------------------ 状态与鉴权 ------------------------------ */

function enabled() {
  return Boolean(PAYHOOK.token)
}

/** 给 /health 与启动横幅用：**启动时就要能看出这个端点开没开** */
function info() {
  return {
    enabled: enabled(),
    products: Object.keys(PAYHOOK.products).length,
    maxCount: PAYHOOK.maxCount,
    hint: enabled()
      ? `已开启（已配置 ${Object.keys(PAYHOOK.products).length} 条商品映射）`
      : '未配置 CMG_PAYHOOK_TOKEN，回调端点关闭'
  }
}

/**
 * 常量时间比对。
 * 逐字符 `===` 会提前返回，攻击者能靠响应时间逐字节试出 token。
 */
function tokenMatches(provided) {
  const a = Buffer.from(String(provided || ''))
  const b = Buffer.from(PAYHOOK.token)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * 取平台传来的 token：优先 `Authorization: Bearer`，退而用查询参数。
 * 退这一手是必要的 —— 不少发卡平台的回调配置里只能填一个 URL，设不了自定义请求头。
 */
function extractToken(req, url) {
  const auth = String(req.headers.authorization || '').trim()
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (m) return m[1].trim()
  return (url.searchParams.get('token') || '').trim()
}

/* ------------------------------ 字段解析 ------------------------------ */

/** 各家平台的字段名不一致，按优先级取第一个非空值 */
function pick(body, ...names) {
  for (const name of names) {
    const v = body[name]
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim()
  }
  return ''
}

/**
 * 商品 ID → 兑换码类型。
 *
 * 先查配置映射，查不到就把 sku 本身当类型试（很多平台直接把 `month` 当商品 ID 传）。
 * 两者都不认就返回 null —— **由调用方明确报错**，见文件头第 3 条。
 */
function resolveKind(sku) {
  const kind = PAYHOOK.products[sku] || sku
  return REDEEM_PLANS[kind] ? kind : null
}

/** 统一响应形状。`content` 是多码拼接的纯文本 —— 发卡平台普遍把它当卡密正文展示。 */
function serialize(order, replayed) {
  const spec = REDEEM_PLANS[order.kind] || {}
  const codes = Array.isArray(order.codes) ? order.codes : []
  return {
    codes,
    content: codes.join('\n'),
    /** 单码时也单独给一个字段：有些平台只认一个卡密字符串 */
    code: codes[0] || '',
    kind: order.kind,
    plan: spec.plan || '',
    days: spec.days || 0,
    orderId: order.order_id ?? order.orderId ?? '',
    replayed
  }
}

/* ------------------------------- 主流程 ------------------------------- */

async function handlePayhook(req, res, url) {
  if (!enabled()) {
    // 503 而不是 404：告诉运维"这个能力存在、只是没开"，而不是让人以为路径写错了
    return fail(res, 503, 'payhook_disabled', '回调端点未启用：请在服务端配置 CMG_PAYHOOK_TOKEN')
  }

  if (!tokenMatches(extractToken(req, url))) {
    db.logEvent('payhook_denied', null, `ip=${clientIp(req)}`)
    return fail(res, 401, 'bad_token', '回调鉴权失败')
  }

  let body
  try {
    body = await readJson(req)
  } catch {
    return fail(res, 400, 'invalid_json', '请求体不是合法 JSON')
  }

  const orderId = pick(body, 'order_id', 'orderId', 'trade_no', 'tradeNo', 'out_trade_no', 'outTradeNo')
  if (!orderId) return fail(res, 400, 'order_required', '缺少订单号（order_id / trade_no）')

  const platform = pick(body, 'platform', 'source') || 'unknown'
  const sku = pick(body, 'sku', 'goods_id', 'goodsId', 'product_id', 'productId')
  const amountRaw = Number(pick(body, 'amount', 'price', 'total'))
  const amount = Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : null

  /* ① 幂等：这个订单已经发过了 → 原样返回上次那批码 */
  const existing = db.getCodeOrder(platform, orderId)
  if (existing) {
    db.logEvent('payhook_replay', null, `${platform} ${orderId}`)
    return ok(res, serialize(existing, true))
  }

  /* ② 商品必须认识 —— 不认识的报错，不落回默认套餐 */
  const kind = resolveKind(sku)
  if (!kind) {
    db.logEvent('payhook_bad_sku', null, `${platform} ${orderId} sku=${sku || '(空)'}`)
    return fail(
      res,
      400,
      'unknown_sku',
      `未识别的商品「${sku || '(空)'}」，请在 CMG_PAYHOOK_PRODUCTS 里配置映射`
    )
  }

  const wanted = Number(pick(body, 'count', 'quantity', 'num')) || 1
  const count = Math.max(1, Math.min(PAYHOOK.maxCount, Math.floor(wanted)))

  /* ③ 先发码（写进 codes 表即生效），再落订单台账 */
  const { codes } = redeem.generateBatch({
    kind,
    count,
    batch: `pay-${platform}-${orderId}`,
    note: `平台订单 ${orderId}${amount ? ` ¥${amount}` : ''}`
  })
  const plain = codes.map((c) => c.code)

  try {
    db.insertCodeOrder({
      platform,
      orderId,
      sku,
      kind,
      codes: plain,
      amount,
      raw: JSON.stringify(body)
    })
  } catch (err) {
    /* 并发的同一订单回调抢先落库了。把刚签发的这批**作废**，返回对方那批 ——
       否则一次付款会在库里留下两批码，其中一批永远没人拿到。 */
    db.deleteCodes(plain)
    const other = db.getCodeOrder(platform, orderId)
    if (other) {
      db.logEvent('payhook_race', null, `${platform} ${orderId}`)
      return ok(res, serialize(other, true))
    }
    db.logEvent('payhook_order_failed', null, `${platform} ${orderId} ${(err && err.message) || ''}`)
    return fail(res, 500, 'order_record_failed', '订单登记失败，请稍后重试')
  }

  db.logEvent('payhook_issued', null, `${platform} ${orderId} ${kind} x${plain.length}`)
  return ok(res, serialize({ kind, codes: plain, order_id: orderId }, false))
}

module.exports = { enabled, info, handlePayhook, resolveKind, tokenMatches }
