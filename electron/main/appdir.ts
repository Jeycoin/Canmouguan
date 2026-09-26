import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 应用数据目录的**稳定锚点**。
 *
 * 为什么不能直接依赖 app.getName()：
 * Electron 的 userData = %APPDATA%/<app.getName()>，而 getName() 优先取
 * package.json 的 productName。所以**只要改产品名，数据目录就跟着变**——
 * 用户辛苦攒的 settings.json（含加密的 API Key）、memory.json、knowledge/
 * 会在一夜之间"消失"（其实是被丢在旧目录里没人读）。
 *
 * 因此这里把目录名**钉死成 ASCII 常量**，与产品名彻底解耦：
 *   - 以后再改名，数据依然在原处，不会再丢一次
 *   - 目录名保持 ASCII，避开中文路径在备份脚本 / NSIS 卸载 / 部分工具链里的坑
 */
const APP_DIR_NAME = 'canmouguan'

/** 历史目录名，按"越新越靠前"排列，用于一次性搬迁 */
const LEGACY_DIR_NAMES = ['Interview Copilot', 'interview-copilot']

/**
 * 固定 userData 路径，并把旧目录的数据搬过来。
 *
 * **必须在 `app.requestSingleInstanceLock()` 之前调用** —— 单实例锁本身就写在
 * userData 里，晚一步就会锁在旧目录、数据在新目录，出现"两个实例都能启动"的怪象。
 */
export function pinUserDataDir(): void {
  /*
   * 逃生口：允许用环境变量指定一个独立的数据目录。
   *
   * 用途是"跑真实主进程但别动真实数据"——例如验证退出收尾、保留策略清理这类
   * 只能在真实 main 里跑的行为。没有这个口子的话，任何针对 main 的自动化验证
   * 都会直接读写用户的 settings.json / sessions.json，风险太大，等同于不敢验。
   */
  const override = process.env.CANMOUGUAN_USER_DATA?.trim()
  if (override) {
    try {
      fs.mkdirSync(override, { recursive: true })
      app.setPath('userData', override)
      console.log(`[参谋官] 使用指定的数据目录：${override}`)
      return
    } catch (err) {
      console.error('[参谋官] 指定数据目录不可用，回退默认逻辑', err)
    }
  }

  let appData: string
  try {
    appData = app.getPath('appData')
  } catch {
    return // 极端环境下拿不到就退回默认行为，不阻断启动
  }

  const target = path.join(appData, APP_DIR_NAME)

  // 目标不存在时，从旧目录整体搬迁（同一卷内 rename 是原子操作，不会搬一半）
  if (!fs.existsSync(target)) {
    for (const legacy of LEGACY_DIR_NAMES) {
      const from = path.join(appData, legacy)
      if (!fs.existsSync(from)) continue
      try {
        fs.renameSync(from, target)
        console.log(`[参谋官] 已将数据目录迁移：${legacy} → ${APP_DIR_NAME}`)
      } catch (err) {
        // 搬迁失败（文件被占用等）就退回旧目录，宁可目录名难看也不能让数据读不到
        console.error(`[参谋官] 数据目录迁移失败，回退到 ${legacy}`, err)
        app.setPath('userData', from)
        return
      }
      break
    }
  }

  if (!fs.existsSync(target)) {
    try {
      fs.mkdirSync(target, { recursive: true })
    } catch (err) {
      console.error('[参谋官] 创建数据目录失败', err)
      return
    }
  }

  app.setPath('userData', target)
}

/** 供自检/日志使用：当前实际生效的数据目录 */
export function currentUserDataDir(): string {
  try {
    return app.getPath('userData')
  } catch {
    return '(unknown)'
  }
}

/**
 * 历史数据目录的**绝对路径**列表。
 *
 * 用途：settings.json 里存着绝对路径（如 `knowledgeDir`）。改产品名后这些路径
 * 会指向已经不存在的旧目录，应用就会以为知识库是空的、重新播种一份模板，
 * 用户自己写的知识库看起来就"没了"（其实文件还在新目录里躺着）。
 * store.loadSettings() 用这个列表把旧路径重映射到当前目录。
 *
 * 注意：**不判断目录是否存在** —— 搬迁完成后旧目录已经没了，但路径字符串仍需要被识别出来。
 */
export function getLegacyUserDataDirs(): string[] {
  try {
    const appData = app.getPath('appData')
    return LEGACY_DIR_NAMES.map((n) => path.join(appData, n))
  } catch {
    return []
  }
}
