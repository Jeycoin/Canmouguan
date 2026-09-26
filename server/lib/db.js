'use strict'

/**
 * 数据层：node:sqlite（Node 22+ 内置，零依赖）。
 *
 * 为什么不用 JSON 文件：用量是**高频写**（每 100ms 一帧 PCM 都要计量），
 * JSON 全量重写会把磁盘打满、也扛不住并发。SQLite 是这里唯一合理的选择，
 * 而且它单文件、无服务、直接 cp 就是备份。
 *
 * 为什么不用 better-sqlite3：它是原生模块，装的时候要编译，
 * 换台机器部署就可能失败。内置的 node:sqlite 没有这个问题。
 */

const { DatabaseSync } = require('node:sqlite')
const { DB_PATH } = require('./env')

const db = new DatabaseSync(DB_PATH)

/* WAL：读写并发下不会互相阻塞（用量写入很频繁，这点很关键）。 */
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA synchronous = NORMAL')
db.exec('PRAGMA foreign_keys = ON')

/* 新账号默认 plan = 'none'（未开通，0 额度）。
   产品没有免费套餐：注册只给账号，额度唯一来源是兑换码。
   （列默认值只是兜底，createUser 一律显式传 plan。） */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account         TEXT    NOT NULL UNIQUE,
  pass_hash       TEXT    NOT NULL,
  pass_salt       TEXT    NOT NULL,
  plan            TEXT    NOT NULL DEFAULT 'none',
  plan_expires_at INTEGER,
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER,
  disabled        INTEGER NOT NULL DEFAULT 0,
  note            TEXT
);

CREATE TABLE IF NOT EXISTS usage (
  user_id      INTEGER NOT NULL,
  period       TEXT    NOT NULL,
  asr_seconds  REAL    NOT NULL DEFAULT 0,
  llm_calls    INTEGER NOT NULL DEFAULT 0,
  llm_tokens   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER,
  PRIMARY KEY (user_id, period),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS codes (
  code        TEXT PRIMARY KEY,
  plan        TEXT    NOT NULL,
  days        INTEGER NOT NULL,
  batch       TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  redeemed_at INTEGER,
  redeemed_by INTEGER
);

CREATE INDEX IF NOT EXISTS idx_codes_batch ON codes(batch);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  user_id INTEGER,
  kind    TEXT    NOT NULL,
  detail  TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_at ON events(at DESC);

/* 手机验证码。
   刻意不建 FOREIGN KEY：注册流程里验证码先于用户存在，没有可指向的 user_id。
   code_hash 是 HMAC（带 gateway.secret 做 pepper），**不明文** —— 见 sms.js。 */
CREATE TABLE IF NOT EXISTS phone_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT    NOT NULL,
  purpose     TEXT    NOT NULL,
  code_hash   TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_phone_codes_lookup ON phone_codes(phone, purpose, id DESC);

/* 发卡平台回调的订单台账。存在的唯一理由是**幂等**：
   平台在没收到 200 时会重试，没有这张表就会"一次付款发两次码"。
   (platform, order_id) 唯一 —— 让数据库而不是应用层来保证这一点。
   注意：这整块是模板字符串，注释里**不能出现反引号**。 */
CREATE TABLE IF NOT EXISTS code_orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  platform   TEXT    NOT NULL,
  order_id   TEXT    NOT NULL,
  sku        TEXT,
  kind       TEXT    NOT NULL,
  codes      TEXT    NOT NULL,
  amount     REAL,
  created_at INTEGER NOT NULL,
  raw        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_code_orders_unique ON code_orders(platform, order_id);
`)

/* ------------------------- 迁移：users.phone -------------------------
   SQLite **不允许** `ALTER TABLE ADD COLUMN ... UNIQUE`（会报 Cannot add a UNIQUE column），
   所以列单独加、唯一性交给下面这条独立索引。
   顺带一个正好合用的语义：唯一索引里多个 NULL 互不冲突，
   所以老账号（phone 为空）可以有很多个，不会互相撞。 */
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name)
if (!userCols.includes('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT')
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone)')

/* ------------------------------- 用户 ------------------------------- */

const qUserByAccount = db.prepare('SELECT * FROM users WHERE account = ?')
const qUserByPhone = db.prepare('SELECT * FROM users WHERE phone = ?')
const qUserById = db.prepare('SELECT * FROM users WHERE id = ?')
const qInsertUser = db.prepare(
  `INSERT INTO users (account, phone, pass_hash, pass_salt, plan, plan_expires_at, created_at, note)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
)
const qTouchLogin = db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
const qSetPlan = db.prepare('UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?')
const qSetPhone = db.prepare('UPDATE users SET phone = ? WHERE id = ?')
const qListUsers = db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT ?')
const qCountUsers = db.prepare('SELECT COUNT(*) AS n FROM users')

function userByAccount(account) {
  return qUserByAccount.get(account) || null
}
function userByPhone(phone) {
  return qUserByPhone.get(phone) || null
}
function userById(id) {
  return qUserById.get(id) || null
}
function createUser({
  account,
  phone = null,
  passHash,
  passSalt,
  /** 默认 'none' = 未开通。带兑换码注册时由 finishRegister 现场开通成 'pro'。 */
  plan = 'none',
  planExpiresAt = null,
  note = null
}) {
  const info = qInsertUser.run(account, phone, passHash, passSalt, plan, planExpiresAt, Date.now(), note)
  return userById(Number(info.lastInsertRowid))
}
function touchLogin(id) {
  qTouchLogin.run(Date.now(), id)
}
function setPlan(id, plan, expiresAt) {
  qSetPlan.run(plan, expiresAt, id)
}
/** 给已存在的账号补绑手机号（目前没有调用方，留给"老账号绑定手机号"用）。 */
function setPhone(id, phone) {
  qSetPhone.run(phone, id)
}
function listUsers(limit = 100) {
  return qListUsers.all(limit)
}
function countUsers() {
  return qCountUsers.get().n
}

/* ------------------------------- 用量 ------------------------------- */

const qUsage = db.prepare('SELECT * FROM usage WHERE user_id = ? AND period = ?')
const qUpsertUsageAsr = db.prepare(
  `INSERT INTO usage (user_id, period, asr_seconds, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(user_id, period) DO UPDATE SET
     asr_seconds = asr_seconds + excluded.asr_seconds,
     updated_at  = excluded.updated_at`
)
const qUpsertUsageLlm = db.prepare(
  `INSERT INTO usage (user_id, period, llm_calls, llm_tokens, updated_at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(user_id, period) DO UPDATE SET
     llm_calls  = llm_calls + excluded.llm_calls,
     llm_tokens = llm_tokens + excluded.llm_tokens,
     updated_at = excluded.updated_at`
)

function getUsage(userId, period) {
  return qUsage.get(userId, period) || { user_id: userId, period, asr_seconds: 0, llm_calls: 0, llm_tokens: 0 }
}
/** 累加 ASR 秒数。以"增量"写入而不是读改写，并发下不会互相覆盖。 */
function addAsrSeconds(userId, period, seconds) {
  if (!(seconds > 0)) return
  qUpsertUsageAsr.run(userId, period, seconds, Date.now())
}
function addLlmUsage(userId, period, calls = 1, tokens = 0) {
  qUpsertUsageLlm.run(userId, period, calls, tokens, Date.now())
}

/* ------------------------------ 兑换码 ------------------------------ */

const qInsertCode = db.prepare(
  'INSERT INTO codes (code, plan, days, batch, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
)
const qCode = db.prepare('SELECT * FROM codes WHERE code = ?')
const qRedeem = db.prepare('UPDATE codes SET redeemed_at = ?, redeemed_by = ? WHERE code = ? AND redeemed_at IS NULL')
const qListCodes = db.prepare('SELECT * FROM codes WHERE batch = ? ORDER BY code')

function insertCode({ code, plan, days, batch = null, note = null }) {
  qInsertCode.run(code, plan, days, batch, note, Date.now())
}
function getCode(code) {
  return qCode.get(code) || null
}
/**
 * 原子核销：`WHERE ... AND redeemed_at IS NULL` 保证同一码只能被成功抢到一次。
 * 两个请求同时兑同一个码时，第二个会拿到 changes=0 —— **不能**先查再写（那会有竞态）。
 */
function redeemCode(code, userId) {
  const info = qRedeem.run(Date.now(), userId, code)
  return info.changes === 1
}
function listCodesByBatch(batch) {
  return qListCodes.all(batch)
}
/**
 * 作废一批码。**只给"订单回滚"用**：并发下两个相同 order_id 的回调同时走到"发码"这一步时，
 * 后落库的那一批必须撤销，否则会凭空多出一批无主的会员码（没人拿得到，但真实存在于库里）。
 */
function deleteCodes(codes) {
  if (!codes || !codes.length) return
  const stmt = db.prepare('DELETE FROM codes WHERE code = ? AND redeemed_at IS NULL')
  for (const code of codes) stmt.run(code)
}

/* --------------------------- 发卡平台订单 --------------------------- */

const qInsertOrder = db.prepare(
  `INSERT INTO code_orders (platform, order_id, sku, kind, codes, amount, created_at, raw)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
)
const qOrder = db.prepare('SELECT * FROM code_orders WHERE platform = ? AND order_id = ?')
const qOrders = db.prepare('SELECT * FROM code_orders ORDER BY id DESC LIMIT ?')

function getCodeOrder(platform, orderId) {
  const row = qOrder.get(platform, orderId)
  if (!row) return null
  // codes 存成 JSON 文本：这个字段只被"原样返回给平台"使用，不参与查询
  let codes = []
  try {
    codes = JSON.parse(row.codes)
  } catch {
    /* 库里的值坏了也不该让回调 500 —— 退化成空数组，平台会看到没有卡密 */
  }
  return { ...row, codes }
}
/**
 * 落订单台账。**唯一索引冲突会抛** —— 这是刻意的：
 * 让调用方（payhook.js）能明确区分"我赢了"和"并发的另一路已经发过了"，
 * 而不是靠"先查再插"那种有竞态的判断。
 */
function insertCodeOrder({ platform, orderId, sku = null, kind, codes, amount = null, raw = null }) {
  qInsertOrder.run(
    platform,
    orderId,
    sku,
    kind,
    JSON.stringify(codes),
    amount,
    Date.now(),
    raw ? String(raw).slice(0, 1000) : null
  )
}
function listCodeOrders(limit = 50) {
  return qOrders.all(limit)
}

/* ---------------------------- 手机验证码 ---------------------------- */

const qInsertPhoneCode = db.prepare(
  'INSERT INTO phone_codes (phone, purpose, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
)
/** 只取"还没用过的最新一条"：重发之后旧码自动失效，用户手上只可能有一个有效码 */
const qLatestPhoneCode = db.prepare(
  'SELECT * FROM phone_codes WHERE phone = ? AND purpose = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1'
)
const qPhoneCodeById = db.prepare('SELECT * FROM phone_codes WHERE id = ?')
const qLastPhoneCodeAt = db.prepare(
  'SELECT created_at FROM phone_codes WHERE phone = ? AND purpose = ? ORDER BY id DESC LIMIT 1'
)
const qConsumePhoneCode = db.prepare(
  'UPDATE phone_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL'
)
const qBumpPhoneCodeAttempts = db.prepare('UPDATE phone_codes SET attempts = attempts + 1 WHERE id = ?')
const qPurgePhoneCodes = db.prepare(
  'DELETE FROM phone_codes WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)'
)

function insertPhoneCode({ phone, purpose, codeHash, expiresAt }) {
  qInsertPhoneCode.run(phone, purpose, codeHash, Date.now(), expiresAt)
}
function latestPhoneCode(phone, purpose) {
  return qLatestPhoneCode.get(phone, purpose) || null
}
/** 上一次**发出**的时间，不管有没有被用掉 —— 用于重发冷却（见 sms.cooldownRemainingMs）。 */
function lastPhoneCodeAt(phone, purpose) {
  const row = qLastPhoneCodeAt.get(phone, purpose)
  return row ? row.created_at : 0
}
/**
 * 原子消费：`WHERE ... AND consumed_at IS NULL` 保证同一个验证码只能被成功用掉一次。
 * 并发下第二个请求拿到 changes=0 —— 和兑换码核销同一个套路，**不能**先查再写。
 */
function consumePhoneCode(id) {
  return qConsumePhoneCode.run(Date.now(), id).changes === 1
}
/** 错一次记一次，返回**累加后**的次数（从库里重读，避免并发下各自读到旧值）。 */
function bumpPhoneCodeAttempts(id) {
  qBumpPhoneCodeAttempts.run(id)
  const row = qPhoneCodeById.get(id)
  return row ? row.attempts : 0
}
/** 清掉过期的与 1 小时前已消费的。不清理的话这张表会一直涨。 */
function purgePhoneCodes(now = Date.now()) {
  qPurgePhoneCodes.run(now, now - 3600000)
}

/* -------------------------------- 事件 -------------------------------- */

const qInsertEvent = db.prepare('INSERT INTO events (at, user_id, kind, detail) VALUES (?, ?, ?, ?)')
const qRecentEvents = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')

function logEvent(kind, userId = null, detail = null) {
  try {
    qInsertEvent.run(Date.now(), userId, kind, detail ? String(detail).slice(0, 500) : null)
  } catch {
    /* 事件日志失败不该影响主流程 */
  }
}
function recentEvents(limit = 50) {
  return qRecentEvents.all(limit)
}

module.exports = {
  db,
  userByAccount,
  userByPhone,
  userById,
  createUser,
  touchLogin,
  setPlan,
  setPhone,
  listUsers,
  countUsers,
  getUsage,
  addAsrSeconds,
  addLlmUsage,
  insertCode,
  getCode,
  redeemCode,
  listCodesByBatch,
  deleteCodes,
  getCodeOrder,
  insertCodeOrder,
  listCodeOrders,
  insertPhoneCode,
  latestPhoneCode,
  lastPhoneCodeAt,
  consumePhoneCode,
  bumpPhoneCodeAttempts,
  purgePhoneCodes,
  logEvent,
  recentEvents
}
