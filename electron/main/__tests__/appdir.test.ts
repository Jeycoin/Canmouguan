import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { pinUserDataDir, currentUserDataDir } from '../appdir'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(), setPath: vi.fn() }
}))

// vi.mock 会被 hoist，所以这里拿到的一定是桩对象
const appMock = app as unknown as {
  getPath: ReturnType<typeof vi.fn>
  setPath: ReturnType<typeof vi.fn>
}

/**
 * 产品改名后最容易出事的地方：
 * Electron 的 userData 默认取自 productName，改名字就等于换数据目录，
 * 用户攒下的 settings.json（含加密 API Key）/ memory.json / knowledge 会全部"消失"。
 * 这里把搬迁逻辑钉死，防止以后再改名时回归。
 */
describe('pinUserDataDir —— 数据目录锚定与旧目录搬迁', () => {
  const BASE = path.join(os.tmpdir(), 'canmouguan-appdir-test')
  let appData: string
  let logSpy: ReturnType<typeof vi.spyOn>

  const target = () => path.join(appData, 'canmouguan')
  const legacyNew = () => path.join(appData, 'Interview Copilot')
  const legacyOld = () => path.join(appData, 'interview-copilot')

  const writeSettings = (dir: string, body: unknown) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(body), 'utf8')
  }

  beforeEach(() => {
    fs.rmSync(BASE, { recursive: true, force: true })
    appData = path.join(BASE, 'Roaming')
    fs.mkdirSync(appData, { recursive: true })
    appMock.getPath.mockImplementation((name: string) => {
      if (name === 'appData') return appData
      throw new Error('测试未预期的 getPath: ' + name)
    })
    appMock.setPath.mockClear()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    fs.rmSync(BASE, { recursive: true, force: true })
  })

  it('把旧目录整体搬迁到新目录，数据一个字都不能少', () => {
    const payload = { llm: { activeProfileId: 'p1' }, apiKeyEnc: 'enc:AQAAANC' }
    writeSettings(legacyNew(), payload)
    fs.writeFileSync(path.join(legacyNew(), 'memory.json'), '{"items":[1,2]}', 'utf8')

    pinUserDataDir()

    expect(fs.existsSync(legacyNew())).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(target(), 'settings.json'), 'utf8'))).toEqual(payload)
    expect(fs.readFileSync(path.join(target(), 'memory.json'), 'utf8')).toBe('{"items":[1,2]}')
    expect(appMock.setPath).toHaveBeenCalledWith('userData', target())
  })

  it('更早的名字 interview-copilot 也能搬', () => {
    writeSettings(legacyOld(), { version: 1 })

    pinUserDataDir()

    expect(fs.existsSync(legacyOld())).toBe(false)
    expect(fs.existsSync(path.join(target(), 'settings.json'))).toBe(true)
  })

  it('新目录已存在时不动旧目录，只指向新目录', () => {
    writeSettings(target(), { version: 2 })
    writeSettings(legacyNew(), { version: 1 })

    pinUserDataDir()

    // 已在新目录上跑过，就不能再被旧目录覆盖
    expect(fs.existsSync(legacyNew())).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(target(), 'settings.json'), 'utf8'))).toEqual({ version: 2 })
    expect(appMock.setPath).toHaveBeenCalledWith('userData', target())
  })

  it('全新安装：目录不存在则创建，并指向它', () => {
    pinUserDataDir()

    expect(fs.existsSync(target())).toBe(true)
    expect(appMock.setPath).toHaveBeenCalledWith('userData', target())
  })

  it('搬迁失败时退回旧目录，保证数据仍可读', () => {
    writeSettings(legacyNew(), { version: 1 })
    // 模拟 rename 失败：让目标路径的父级不可写是平台相关的，
    // 这里直接把 renameSync 打桩成抛错，验证回退分支
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EBUSY: resource busy or locked')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    pinUserDataDir()

    expect(appMock.setPath).toHaveBeenCalledWith('userData', legacyNew())
    expect(fs.existsSync(path.join(legacyNew(), 'settings.json'))).toBe(true)
    spy.mockRestore()
    errSpy.mockRestore()
  })

  it('拿不到 appData 时不抛错（不阻断启动）', () => {
    appMock.getPath.mockImplementation(() => {
      throw new Error('no appData')
    })

    expect(() => pinUserDataDir()).not.toThrow()
    expect(appMock.setPath).not.toHaveBeenCalled()
  })

  it('currentUserDataDir 读取的是当前生效目录', () => {
    appMock.getPath.mockImplementation((name: string) => {
      if (name === 'appData') return appData
      if (name === 'userData') return target()
      throw new Error('unexpected')
    })
    expect(currentUserDataDir()).toBe(target())
  })
})
