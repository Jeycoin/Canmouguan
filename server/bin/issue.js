#!/usr/bin/env node
'use strict'

/**
 * 运营命令行。没有管理后台 UI —— 第一步验证阶段用命令行**更快也更不容易出错**，
 * 而且这些操作（发码、看用量）本来就是低频动作，不值得为它写一个前端。
 *
 * 用法：
 *   node server/bin/issue.js issue month 10            # 生成 10 个「专业版 1 个月」兑换码
 *   node server/bin/issue.js issue year 3 --note 首批发售
 *   node server/bin/issue.js list <批次号>              # 看某批码的核销情况
 *   node server/bin/issue.js users                     # 用户列表
 *   node server/bin/issue.js usage <账号>               # 某账号的用量明细
 *   node server/bin/issue.js stats                     # 全局概览
 *
 * 注：可用类型见 `server/lib/env.js` 的 REDEEM_PLANS（month / quarter / year）。
 * 直接执行不带参数会把这几个类型列出来。
 */

const originalEmitWarning = process.emitWarning
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : warning && warning.message
  if (typeof text === 'string' && text.includes('SQLite is an experimental feature')) return
  return originalEmitWarning.call(process, warning, ...rest)
}

const path = require('node:path')
const { REDEEM_PLANS, DATA_DIR } = require(path.join(__dirname, '..', 'lib', 'env'))
const db = require(path.join(__dirname, '..', 'lib', 'db'))
const redeem = require(path.join(__dirname, '..', 'lib', 'redeem'))
const quota = require(path.join(__dirname, '..', 'lib', 'quota'))

const argv = process.argv.slice(2)
const cmd = argv[0]
const flags = {}
const positional = []
for (const a of argv.slice(1)) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=')
    flags[k] = v === undefined ? true : v
  } else positional.push(a)
}

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN') : '—')
const fmtHours = (sec) => `${(sec / 3600).toFixed(2)} 小时`

function cmdIssue() {
  const kind = positional[0] || 'month'
  const count = Number(positional[1] || 1)
  if (!REDEEM_PLANS[kind]) {
    console.error(`未知类型：${kind}`)
    console.error(`可选：${Object.keys(REDEEM_PLANS).join(' / ')}`)
    process.exit(1)
  }
  const { batch, codes } = redeem.generateBatch({
    kind,
    count,
    batch: typeof flags.batch === 'string' ? flags.batch : null,
    note: typeof flags.note === 'string' ? flags.note : null
  })
  console.log(`\n批次 ${batch}　${REDEEM_PLANS[kind].name}　共 ${codes.length} 个\n`)
  for (const c of codes) console.log(`  ${c.code}`)
  console.log(`\n把上面这些码发出去即可（用户在客户端「兑换码」处输入）。`)
  console.log(`查看核销情况：node server/bin/issue.js list ${batch}\n`)
}

function cmdList() {
  const batch = positional[0]
  if (!batch) {
    console.error('用法：list <批次号>')
    process.exit(1)
  }
  const rows = db.listCodesByBatch(batch)
  if (!rows.length) {
    console.error(`批次 ${batch} 没有找到兑换码`)
    process.exit(1)
  }
  const used = rows.filter((r) => r.redeemed_at).length
  console.log(`\n批次 ${batch}：共 ${rows.length} 个，已核销 ${used} 个，未核销 ${rows.length - used} 个\n`)
  for (const r of rows) {
    const mark = r.redeemed_at ? `已用（用户 #${r.redeemed_by}，${fmtTime(r.redeemed_at)}）` : '未用'
    console.log(`  ${r.code}  +${r.days}天  ${mark}`)
  }
  console.log('')
}

function cmdUsers() {
  const users = db.listUsers(200)
  console.log(`\n共 ${users.length} 个用户\n`)
  console.log('  ID   账号                     套餐      到期            已用语音      已用提问  注册时间')
  for (const u of users) {
    const ent = quota.entitlement(u)
    /* 未开通与已到期都显示 'none'（额度都是 0），用末尾的 [已到期] 区分 ——
       运营真正要区分的就是这两种人：一个要拉新，一个要催续费。 */
    const plan = ent.paidActive ? `${ent.plan.id}(${ent.plan.name})` : 'none'
    console.log(
      `  ${String(u.id).padEnd(4)} ${u.account.padEnd(24)} ${plan.padEnd(9)} ${fmtTime(ent.planExpiresAt).padEnd(15)} ` +
        `${fmtHours(ent.asr.used).padEnd(13)} ${String(ent.llm.used).padEnd(9)} ${fmtTime(u.created_at)}` +
        (u.disabled ? '  [已停用]' : '') +
        (ent.expired ? `  [已到期 ${fmtTime(ent.expiredAt)}]` : '')
    )
  }
  console.log('')
}

function cmdUsage() {
  const account = positional[0]
  if (!account) {
    console.error('用法：usage <账号>')
    process.exit(1)
  }
  const user = db.userByAccount(account)
  if (!user) {
    console.error(`找不到账号：${account}`)
    process.exit(1)
  }
  const ent = quota.entitlement(user)
  const state = ent.paidActive ? `${ent.plan.name}（有效）` : ent.expired ? '已到期（无有效额度）' : '未开通（无有效额度）'
  console.log(`\n账号 ${user.account}`)
  console.log(`  套餐权重　${state}`)
  console.log(`  到期时间　${fmtTime(ent.planExpiresAt || ent.expiredAt)}`)
  console.log(`  计费周期　${ent.period}`)
  console.log(`  语音用量　${fmtHours(ent.asr.used)} / ${fmtHours(ent.asr.limit)}　剩余 ${fmtHours(ent.asr.remaining)}`)
  console.log(`  提问次数　${ent.llm.used} / ${ent.llm.limit}　剩余 ${ent.llm.remaining}`)
  const recent = db.recentEvents(200).filter((e) => e.user_id === user.id).slice(0, 15)
  if (recent.length) {
    console.log('\n  最近事件：')
    for (const e of recent) console.log(`    ${fmtTime(e.at)}  ${e.kind}  ${e.detail || ''}`)
  }
  console.log('')
}

function cmdStats() {
  const users = db.listUsers(10000)
  let asrTotal = 0
  let llmTotal = 0
  let paid = 0
  for (const u of users) {
    const ent = quota.entitlement(u)
    asrTotal += ent.asr.used
    llmTotal += ent.llm.used
    if (ent.paidActive) paid++
  }
  /* 成本按实测单价折算，方便一眼看出毛利：
     realtime ¥0.864/h、file ¥0.288/h，取两者平均 ¥0.576/h 做粗估 */
  const cost = (asrTotal / 3600) * 0.576
  console.log(`\n数据库　${DATA_DIR}`)
  console.log(`  用户数　　　${users.length}（其中会员有效 ${paid}）`)
  console.log(`  语音总量　　${fmtHours(asrTotal)}`)
  console.log(`  提问总量　　${llmTotal} 次`)
  console.log(`  上游成本粗估　约 ¥${cost.toFixed(2)}　（按双通道均价 ¥0.576/小时）`)
  const events = db.recentEvents(10)
  if (events.length) {
    console.log('\n  最近事件：')
    for (const e of events) console.log(`    ${fmtTime(e.at)}  #${e.user_id ?? '-'}  ${e.kind}  ${e.detail || ''}`)
  }
  console.log('')
}

switch (cmd) {
  case 'issue':
    cmdIssue()
    break
  case 'list':
    cmdList()
    break
  case 'users':
    cmdUsers()
    break
  case 'usage':
    cmdUsage()
    break
  case 'stats':
    cmdStats()
    break
  default:
    console.log(`
参谋官网关 · 运营命令

  issue <类型> <数量> [--batch=xxx] [--note=xxx]   生成兑换码
  list <批次号>                                   查看某批码的核销情况
  users                                          用户列表
  usage <账号>                                    某账号用量明细
  stats                                          全局概览

兑换码类型：
${Object.entries(REDEEM_PLANS).map(([k, v]) => `  ${k.padEnd(10)} ${v.name}`).join('\n')}
`)
}
