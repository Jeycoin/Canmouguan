'use strict'

/**
 * 短信**配置闸门**的独立测试。
 *
 * 为什么不塞进 selftest：这些是"启动配置"层面的不变量，需要在**不同的环境变量组合**下
 * 重新 require 一次 `lib/sms.js`（env.js 在 require 时就把配置定死了）。
 * 塞进 selftest 的话得为每种组合起一个完整网关，太重；这里用自身递归 spawn 就够了。
 *
 * 三条不变量：
 *   1. 通道名写错 → 明确报"未知通道"，而不是回退到某个默认值悄悄跑起来
 *   2. 生产环境 + console 通道 → **拒绝发送**（把登录验证码写进日志 = 谁看日志谁能登任意账号）
 *   3. 发不出去时**不能在库里留下可用的验证码**
 */

const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const results = []
function check(desc, pass, detail = '') {
  results.push([desc, pass])
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${desc}${detail ? `   [${detail}]` : ''}`)
}

/**
 * 跑一个子用例。
 *
 * ⚠️ 用异步 spawn，**不要用 spawnSync** —— 本机上 spawnSync 一律 `EBUSY`
 * （连普通 Node 进程都会，不只是 Electron 主进程），而且它是静默失败：
 * status=null、stdout=undefined，看起来像"子进程什么都没输出"。
 * 必须带 watchdog：子进程挂住时不能让整个测试跟着挂。
 */
function runCase(name, env, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [__filename, name], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.stderr.on('data', (d) => (out += d.toString()))
    const timer = setTimeout(() => {
      out += `\n[killed] 子用例 ${name} 超过 ${timeoutMs}ms`
      try {
        p.kill()
      } catch {
        /* noop */
      }
    }, timeoutMs)
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

/* --------------------------- 子进程：单个用例 --------------------------- */

const CASES = {
  'bogus-provider': () => {
    const sms = require('../lib/sms')
    const info = sms.providerInfo()
    return [
      ['通道名写错时判定为未就绪', info.ready === false, `provider=${info.name} ready=${info.ready}`],
      ['未知通道给出可操作提示', /未知短信通道/.test(info.hint), info.hint]
    ]
  },
  'prod-console': () => {
    const sms = require('../lib/sms')
    const info = sms.providerInfo()
    return [
      ['生产环境 + console 通道 → 拒绝', info.ready === false && info.blocked === true, JSON.stringify(info)],
      ['拒绝理由说明白为什么要改配置', /日志/.test(info.hint), info.hint]
    ]
  },
  'prod-console-forced': () => {
    const sms = require('../lib/sms')
    return [['显式放行时 console 可用（受控环境用）', sms.providerInfo().ready === true]]
  },
  'prod-console-send': async () => {
    const sms = require('../lib/sms')
    const db = require('../lib/db')
    const phone = '13800009999'
    let threw = null
    try {
      await sms.issueCode(phone, 'login')
    } catch (err) {
      threw = err
    }
    return [
      ['生产环境下真的发不出去（不是只报个状态）', Boolean(threw), threw ? threw.message : '未抛错'],
      ['失败原因可被客户端识别（sms_not_configured）', threw && threw.reason === 'sms_not_configured', threw && threw.reason],
      ['发不出去就不落库（不留可用验证码）', db.lastPhoneCodeAt(phone, 'login') === 0, `lastAt=${db.lastPhoneCodeAt(phone, 'login')}`]
    ]
  }
}

const caseName = process.argv[2]
if (caseName) {
  const run = CASES[caseName]
  Promise.resolve()
    .then(() => run())
    .then((rows) => {
      for (const row of rows) check(...row)
      process.exit(results.every(([, p]) => p) ? 0 : 1)
    })
    .catch((err) => {
      console.log(`FAIL 子用例 ${caseName} 异常：`, (err && err.stack) || err)
      process.exit(1)
    })
} else {
  ;(async () => {
    console.log('[sms-config] 短信配置闸门\n')
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmg-sms-cfg-'))
    const base = { ...process.env, CMG_DATA_DIR: dataDir, CMG_SMS_PROVIDER: 'console' }
    delete base.NODE_ENV
    delete base.CMG_SMS_ALLOW_CONSOLE

    const envs = {
      'bogus-provider': { ...base, CMG_SMS_PROVIDER: 'twilio' },
      'prod-console': { ...base, NODE_ENV: 'production' },
      'prod-console-forced': { ...base, NODE_ENV: 'production', CMG_SMS_ALLOW_CONSOLE: '1' },
      'prod-console-send': { ...base, NODE_ENV: 'production' }
    }

    for (const [name, env] of Object.entries(envs)) {
      console.log(`· 用例 ${name}`)
      const r = await runCase(name, env)
      const out = r.out || ''
      for (const line of out.split(/\r?\n/)) {
        if (/^\s{2}(ok|FAIL)\s/.test(line)) {
          const pass = line.includes('ok  ')
          results.push([line.trim(), pass])
          console.log(`  ${line.trim()}`)
        }
      }
      if (r.code !== 0 && !/FAIL/.test(out)) {
        check(
          `子用例 ${name} 正常退出`,
          false,
          `exit=${r.code} ${out.trim().split('\n').slice(-3).join(' | ')}`
        )
      }
    }

    try {
      fs.rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* noop */
    }

    const failed = results.filter(([, p]) => !p).length
    console.log(failed ? `\nSMS_CONFIG_FAIL（${failed} 项未通过）` : '\nSMS_CONFIG_OK')
    process.exit(failed ? 1 : 0)
  })()
}
