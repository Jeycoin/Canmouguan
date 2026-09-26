import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, on, type AppSettings, type CloudSettings, type InterviewSession } from './api'

export interface Toast {
  id: number
  text: string
  level?: 'info' | 'warn' | 'error'
}

export interface WindowState {
  clickThrough: boolean
  collapsed: boolean
  alwaysOnTop: boolean
  opacity: number
  stealth: boolean
}

interface AppCtx {
  settings: AppSettings | null
  reloadSettings: () => Promise<void>
  patch: (p: Partial<AppSettings>) => Promise<void>
  /**
   * 只改 `settings.cloud` 里的某几个字段。
   *
   * 为什么不直接用 `patch({ cloud: {...} })`：那要求传一份**完整**的 CloudSettings，
   * 于是调用点只能把当前快照摊开回写 —— 而快照里的 `lastMe`（额度）可能比主进程里的旧，
   * 回写就会让"已用额度"凭空回涨。这里只挑调用方真的想改的字段送过去，
   * 其余交给主进程的 deepMerge 保持原样。
   */
  patchCloud: (p: Partial<CloudSettings>) => Promise<void>
  toasts: Toast[]
  toast: (text: string, level?: Toast['level']) => void
  windowState: WindowState
  refreshWindowState: () => Promise<void>
  session: InterviewSession | null
  setSession: (s: InterviewSession | null) => void
  panic: boolean
  setPanic: (v: boolean) => void
  /** 全局快捷键触发的录音切换计数器 */
  recToggleSignal: number
  shotSignal: number
  /** 全局快捷键触发的紧急静音计数器（旧版本只弹提示、没真的静音） */
  muteSignal: number
}

const Ctx = createContext<AppCtx | null>(null)

let toastSeq = 0

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [session, setSession] = useState<InterviewSession | null>(null)
  const [panic, setPanic] = useState(false)
  const [recToggleSignal, setRecToggleSignal] = useState(0)
  const [shotSignal, setShotSignal] = useState(0)
  const [muteSignal, setMuteSignal] = useState(0)
  const [windowState, setWindowState] = useState<WindowState>({
    clickThrough: false,
    collapsed: false,
    alwaysOnTop: true,
    opacity: 0.94,
    stealth: false
  })
  const timers = useRef<Map<number, number>>(new Map())

  const toast = useCallback((text: string, level: Toast['level'] = 'info') => {
    const id = ++toastSeq
    setToasts((t) => [...t, { id, text, level }])
    const timer = window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id))
      timers.current.delete(id)
    }, 2800)
    timers.current.set(id, timer)
  }, [])

  const reloadSettings = useCallback(async () => {
    const s = await api.getSettings()
    setSettings(s)
    return
  }, [])

  const patch = useCallback(
    async (p: Partial<AppSettings>) => {
      const next = await api.patchSettings(p)
      setSettings(next)
    },
    []
  )

  /* patchCloud 需要"当前值"来补全未修改的字段。用 ref 而不是闭包捕获 settings，
     这样 patchCloud 本身是稳定引用（不会让消费它的组件每次广播都重渲染）。 */
  const settingsRef = useRef<AppSettings | null>(null)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  const patchCloud = useCallback(async (p: Partial<CloudSettings>) => {
    const cur = settingsRef.current?.cloud
    // 只送 enabled / baseURL（+ 调用方要改的字段），**绝不回写 lastMe 与 token**
    const next = await api.patchSettings({
      cloud: { enabled: cur?.enabled ?? true, baseURL: cur?.baseURL ?? '', ...p }
    } as Partial<AppSettings>)
    setSettings(next)
  }, [])

  const refreshWindowState = useCallback(async () => {
    const s = await api.windowState()
    setWindowState(s)
  }, [])

  useEffect(() => {
    void reloadSettings()
    void refreshWindowState()
    void api.sessionCurrent().then((s) => setSession((s as InterviewSession | null) ?? null))

    const offs: (() => void)[] = []
    offs.push(on<Toast>('toast', (t) => toast(t.text, t.level ?? 'info')))
    offs.push(on<WindowState>('window:state', (s) => setWindowState(s)))
    offs.push(on<AppSettings>('settings:changed', (s) => setSettings(s)))
    offs.push(on<InterviewSession | null>('session:changed', (s) => setSession(s ?? null)))
    offs.push(on('hotkey:toggleRecording', () => setRecToggleSignal((v) => v + 1)))
    offs.push(on('hotkey:screenshot', () => setShotSignal((v) => v + 1)))
    offs.push(on('hotkey:panicHide', () => setPanic(true)))
    // 只自增信号，真正的静音动作由持有 recorder 的 useChat 执行
    offs.push(on('hotkey:panicMute', () => setMuteSignal((v) => v + 1)))
    offs.push(on('review:error', (p: { message: string }) => toast(`复盘失败：${p.message}`, 'error')))
    offs.push(
      on<{ created: number }>('review:done', (p) => toast(`复盘完成，新增 ${p.created} 条知识点记忆`, 'info'))
    )
    return () => offs.forEach((f) => f())
  }, [reloadSettings, refreshWindowState, toast])

  const value = useMemo<AppCtx>(
    () => ({
      settings,
      reloadSettings,
      patch,
      patchCloud,
      toasts,
      toast,
      windowState,
      refreshWindowState,
      session,
      setSession,
      panic,
      setPanic,
      recToggleSignal,
      shotSignal,
      muteSignal
    }),
    [
      settings,
      reloadSettings,
      patch,
      patchCloud,
      toasts,
      toast,
      windowState,
      refreshWindowState,
      session,
      panic,
      recToggleSignal,
      shotSignal,
      muteSignal
    ]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useApp(): AppCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用')
  return ctx
}
