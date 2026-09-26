import { useCallback, useEffect, useState } from 'react'
import { AppProvider, useApp } from './context'
import { api, on } from './api'
import { TitleBar } from './components/TitleBar'
import { ChatPanel } from './components/ChatPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { KnowledgePanel } from './components/KnowledgePanel'
import { MemoryPanel } from './components/MemoryPanel'
import { ReviewPanel } from './components/ReviewPanel'
import { LoginGate } from './components/LoginGate'

type TabId = 'chat' | 'kb' | 'memory' | 'review' | 'settings'

function Shell() {
  const { toasts, windowState, panic, setPanic, settings, toast, refreshWindowState } = useApp()
  const [tab, setTab] = useState<TabId>('chat')

  // 背景不透明度：主进程广播的 opacity 只套在毛玻璃背景上（CSS 变量），文字不受影响
  useEffect(() => {
    const alpha = Math.max(0.15, Math.min(1, windowState.opacity ?? 0.92))
    document.documentElement.style.setProperty('--bg-alpha', String(alpha))
  }, [windowState.opacity])
  const [kbCount, setKbCount] = useState(0)
  const [memCount, setMemCount] = useState(0)
  const [dueCount, setDueCount] = useState(0)

  const refreshBadges = useCallback(async () => {
    const [docs, stats] = await Promise.all([api.kbList(), api.memStats()])
    setKbCount(docs.length)
    setMemCount(stats.total)
    setDueCount(stats.due)
  }, [])

  useEffect(() => {
    void refreshBadges()
    const offs: (() => void)[] = []
    offs.push(on('kb:changed', refreshBadges))
    offs.push(on('memory:changed', refreshBadges))
    return () => offs.forEach((f) => f())
  }, [refreshBadges])

  /**
   * 从紧急隐藏恢复。
   * 旧实现是 window.location.reload() —— 那样会连同整个对话历史、
   * 正在进行的流式回答和录音状态一起丢掉，恢复的代价太大。
   * 正确做法：解除 panic 遮罩 + 取消鼠标穿透 + 重新显示窗口即可。
   */
  const recoverFromPanic = useCallback(async () => {
    setPanic(false)
    try {
      await api.windowAction('clickThrough', false)
      await api.windowAction('show')
      await refreshWindowState()
    } catch (err) {
      toast(`恢复失败：${(err as Error).message}`, 'error')
    }
  }, [setPanic, refreshWindowState, toast])

  /** 关闭按钮 = 隐藏到托盘，而不是让用户以为程序已退出 */
  const hideToTray = useCallback(() => {
    toast('已最小化到托盘，托盘图标右键可完全退出', 'info')
    void api.windowAction('hide')
  }, [toast])

  const TABS: { id: TabId; name: string; badge?: number }[] = [
    { id: 'chat', name: '对话' },
    { id: 'kb', name: '知识库', badge: kbCount },
    { id: 'memory', name: '记忆', badge: memCount },
    { id: 'review', name: '复习', badge: dueCount },
    { id: 'settings', name: '设置' }
  ]

  const cls = `app ${windowState.clickThrough ? 'click-through' : ''} ${panic ? 'panic' : ''}`

  /** 提示条在主界面与登录页都要能显示 —— 登录失败的原因必须看得见 */
  const toastStack = (
    <div style={{ position: 'fixed', bottom: 8, left: 0, right: 0, pointerEvents: 'none' }}>
      {toasts.map((t) => (
        <div key={t.id} className="toast" style={{ position: 'relative', marginBottom: 4 }}>
          {t.text}
        </div>
      ))}
    </div>
  )

  /**
   * 登录闸门：**未登录时整个应用只有这一屏**，连面板都不挂载。
   *
   * 为什么是"闸门"而不是"设置里的一个选项"：上游密钥只存在于自建网关，
   * 客户端没有任何离线路径 —— 没登录时录音发不出去、提问也发不出去。
   * 与其让用户进到主界面里到处撞到"未登录"，不如在门口说清楚。
   *
   * `settings === null` 是启动瞬间的那一帧。这里必须与"未登录"区分开，
   * 否则每次启动都会先闪一下登录页再跳回主界面。
   */
  if (!settings || !settings.cloud?.hasToken) {
    return (
      <div className={cls}>
        <TitleBar onQuit={hideToTray} />
        {settings ? <LoginGate /> : <div className="panel muted">加载中…</div>}
        {toastStack}
      </div>
    )
  }

  return (
    <div className={cls}>
      <TitleBar onQuit={hideToTray} />

      <div className="tabs">
        {TABS.map((t) => (
          <div key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.name}
            {!!t.badge && <span className="badge">{t.badge}</span>}
          </div>
        ))}
      </div>

      {/*
        所有面板保持挂载、用 CSS 切换显隐。
        早期版本用 `{tab === 'chat' && <ChatPanel />}` 条件渲染，切一次 Tab 就会卸载
        ChatPanel —— useChat / useRecorder 随之销毁，导致「对话历史清空」和
        「录音被静默中断」，而录音恰好是本工具的主链路。
      */}
      <div className="pane" hidden={tab !== 'chat'}>
        <ChatPanel />
      </div>
      <div className="pane" hidden={tab !== 'kb'}>
        <KnowledgePanel />
      </div>
      <div className="pane" hidden={tab !== 'memory'}>
        <MemoryPanel />
      </div>
      <div className="pane" hidden={tab !== 'review'}>
        <ReviewPanel />
      </div>
      <div className="pane" hidden={tab !== 'settings'}>
        <SettingsPanel />
      </div>

      {toastStack}

      {panic && (
        <div
          className="panel"
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(10,12,18,0.9)',
            zIndex: 300
          }}
          onClick={() => void recoverFromPanic()}
        >
          <div className="muted">已紧急隐藏。点击任意处恢复，或用快捷键 {settings?.hotkeys.toggleWindow} 唤出。</div>
        </div>
      )}
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  )
}
