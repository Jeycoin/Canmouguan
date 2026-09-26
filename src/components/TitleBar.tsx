import { useEffect, useState } from 'react'
import { useApp } from '../context'
import { api } from '../api'

export function TitleBar({ onQuit }: { onQuit?: () => void }) {
  const { windowState, refreshWindowState, session, toast } = useApp()
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    let timer: number | undefined
    const off = api.on('ui:flash', () => {
      // 连拍时先清掉上一个定时器，否则前一次的 400ms 会把新的闪光提前掐灭
      if (timer !== undefined) window.clearTimeout(timer)
      setFlash(true)
      timer = window.setTimeout(() => setFlash(false), 400)
    })
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      off()
    }
  }, [])

  const act = async (action: string, value?: number | boolean) => {
    await api.windowAction(action, value)
    await refreshWindowState()
  }

  return (
    <>
      <div className="titlebar">
        <div className="dots">
          <button className="dot close" title="退出" onClick={onQuit} />
          <button className="dot min" title="折叠" onClick={() => act('toggleCollapse')} />
          <button className="dot hide" title="隐藏" onClick={() => act('hide')} />
        </div>
        <span className="title">参谋官</span>
        {session && <span className="title-badge">面试中 · {session.company || '未命名'}</span>}

        <div className="spacer" />

        <button
          className={`tb-btn ${windowState.clickThrough ? 'active' : ''}`}
          title="鼠标穿透：开启后点击会穿过窗口落到下方页面"
          onClick={() => {
            void act('toggleClickThrough')
            toast(windowState.clickThrough ? '已恢复可交互' : '鼠标穿透已开启，点击将穿过窗口')
          }}
        >
          {windowState.clickThrough ? '穿透中' : '可交互'}
        </button>
        <button
          className={`tb-btn ${windowState.alwaysOnTop ? 'active' : ''}`}
          title="始终置顶"
          onClick={() => void act('toggleAlwaysOnTop')}
        >
          置顶
        </button>
        <button className="tb-btn" title="移动到鼠标所在显示器" onClick={() => void act('moveToCursor')}>
          移屏
        </button>
        <button className="tb-btn danger" title="紧急隐藏" onClick={() => void act('hide')}>
          隐藏
        </button>
      </div>
      {flash && <div className="flash" />}
    </>
  )
}
