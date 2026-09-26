import { globalShortcut } from 'electron'
import { getSettings, saveSettings } from './store'
import type { HotkeySettings } from '../shared/types'

type Action = keyof HotkeySettings

const actions: Record<Action, () => void> = {
  toggleWindow: () => void 0,
  toggleClickThrough: () => void 0,
  toggleAlwaysOnTop: () => void 0,
  toggleRecording: () => void 0,
  screenshot: () => void 0,
  panicHide: () => void 0,
  panicMute: () => void 0
}

export function registerAction(action: Action, fn: () => void) {
  actions[action] = fn
}

/**
 * 冲突检测：
 * - dupWithSelf：与自身其它快捷键重复
 * - occupiedBySystem：被其它应用/已注册占用（Electron 只能探测本进程，外部占用尽力而为）
 */
export function detectConflict(candidate: string, self: Action): { conflict: boolean; reason?: string; module?: string } {
  if (!candidate) return { conflict: false }
  const s = getSettings()
  for (const [key, value] of Object.entries(s.hotkeys)) {
    if (key === self) continue
    if (value && normalize(value) === normalize(candidate)) {
      return { conflict: true, reason: `与「${ACTION_LABELS[key as Action] ?? key}」冲突`, module: key }
    }
  }
  if (globalShortcut.isRegistered(candidate)) {
    return { conflict: true, reason: '该组合已被系统或其它应用占用' }
  }
  return { conflict: false }
}

export const ACTION_LABELS: Record<Action, string> = {
  toggleWindow: '显示/隐藏窗口',
  toggleClickThrough: '鼠标穿透 / 可交互',
  toggleAlwaysOnTop: '切换始终置顶',
  toggleRecording: '开始/停止录音',
  screenshot: '一键截图分析',
  panicHide: '紧急隐藏',
  panicMute: '紧急静音'
}

function normalize(acc: string): string {
  return acc
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('+')
}

export function registerAllHotkeys() {
  unregisterAllHotkeys()
  const s = getSettings()
  const results: { action: Action; accelerator: string; ok: boolean; reason?: string }[] = []

  for (const action of Object.keys(actions) as Action[]) {
    const acc = s.hotkeys[action]
    if (!acc) continue
    // 先探测是否被外部占用
    if (globalShortcut.isRegistered(acc) && !isOwn(acc, action)) {
      results.push({ action, accelerator: acc, ok: false, reason: '被系统或其它应用占用' })
      continue
    }
    try {
      const ok = globalShortcut.register(acc, () => {
        try {
          actions[action]()
        } catch (err) {
          console.error(`[hotkey] ${action} 执行失败`, err)
        }
      })
      results.push({ action, accelerator: acc, ok, reason: ok ? undefined : '注册失败' })
    } catch (err) {
      results.push({ action, accelerator: acc, ok: false, reason: String(err) })
    }
  }
  return results
}

function isOwn(acc: string, self: Action): boolean {
  // Electron 的 isRegistered 无法区分来源，这里只靠设置表判断是不是自己刚注册的
  return Object.entries(getSettings().hotkeys).some(([k, v]) => k !== self && v === acc)
}

export function unregisterAllHotkeys() {
  globalShortcut.unregisterAll()
}

export function updateHotkey(action: Action, accelerator: string): { ok: boolean; reason?: string } {
  const check = detectConflict(accelerator, action)
  if (check.conflict) return { ok: false, reason: check.reason }
  const s = getSettings()
  s.hotkeys[action] = accelerator
  saveSettings(s)
  const results = registerAllHotkeys()
  const failed = results.find((r) => !r.ok)
  if (failed) return { ok: false, reason: failed.reason }
  return { ok: true }
}

export function getHotkeyStatus() {
  return registerAllHotkeys()
}
