import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, DASHSCOPE_MODELS, CLOUD_LLM_MODELS } from '../api'
import { useApp } from '../context'
import { CloudPanel } from './CloudPanel'
import type { HotkeySettings, LLMProfile } from '../api'

/** 代码题常用作答语言；选「自定义」可在下方输入框里填任意值 */
const CODE_LANGS = ['Java', 'Python', 'C++', 'Go', 'JavaScript', 'TypeScript', 'C#', 'Rust', 'Kotlin', 'Swift', 'PHP', 'SQL']

/**
 * 把「配置里存的值」映射成「实际会用的值」。
 *
 * 必须做这一层映射，因为网关对非白名单模型是**静默改写**的：
 * 存量配置里还留着 BYOK 时代的模型名（如 qwen-vl-max-latest），
 * 直接原样显示在 select 里会指向一个不存在的选项而变成空白，
 * 而且用户会以为"我在用 qwen" —— 实际跑的是服务端默认模型。
 * 这里统一显示**实际会用的那个**，必要时在下面给一行说明。
 */
function pickModel(wanted: string | undefined, list: string[], fallback: string): string {
  const w = (wanted || '').trim()
  if (w && list.includes(w)) return w
  return list.includes(fallback) ? fallback : list[0] ?? w
}

/* ------------------------------ 小组件 ------------------------------ */

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', padding: '3px 0' }}>
      <span style={{ fontSize: 12 }}>{label}</span>
      <button className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />
    </div>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
}) {
  return (
    <div className="field">
      <label>
        {label} <span className="muted">{format ? format(value) : value}</span>
      </label>
      <input
        className="range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

/**
 * ⚠️ 这里原本有一个 `SecretField`（填 API Key 的输入框），已随"完全屏蔽自带 Key"整块删除。
 *
 * 这不是"藏起来"而是**取消入口**：主进程的落点恒为网关（见 `electron/main/cloud.ts`），
 * 就算有办法把 Key 写进设置也不会被使用 —— 两层一致，才不会出现
 * "界面上没了、代码里还留着一条能用"的错位。
 * 写密钥的 IPC（`settings:setSecret`）刻意保留着，将来要恢复 BYOK 时能直接复用。
 */

function HotkeyRow({ action, label, value }: { action: keyof HotkeySettings; label: string; value: string }) {
  const { toast } = useApp()
  const [listening, setListening] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)

  useEffect(() => {
    if (!listening) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setListening(false)
        return
      }
      const parts: string[] = []
      if (e.ctrlKey) parts.push('Ctrl')
      if (e.altKey) parts.push('Alt')
      if (e.shiftKey) parts.push('Shift')
      if (e.metaKey) parts.push('Super')
      let key = e.key
      if (key === ' ') key = 'Space'
      else if (key.length === 1) key = key.toUpperCase()
      else if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return
      parts.push(key)
      const acc = parts.join('+')
      setListening(false)
      void api.checkHotkey(action, acc).then((c) => {
        if (c.conflict) {
          setConflict(c.reason ?? '冲突')
          toast(`快捷键冲突：${c.reason}`, 'error')
          return
        }
        setConflict(null)
        void api.updateHotkey(action, acc).then((r) => {
          if (!r.ok) {
            setConflict(r.reason ?? '注册失败')
            toast(`快捷键注册失败：${r.reason}`, 'error')
          } else {
            toast(`已设置为 ${acc}`, 'info')
          }
        })
      })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [listening, action, toast])

  return (
    <div className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
      <span style={{ fontSize: 12 }}>{label}</span>
      <div className="row" style={{ gap: 6 }}>
        {conflict && <span className="pill err">{conflict}</span>}
        <span
          className={`kbd ${listening ? 'recording' : ''} ${conflict ? 'conflict' : ''}`}
          onClick={() => setListening(true)}
          title="点击后按下新的组合键，Esc 取消"
        >
          {listening ? '按下…' : value || '未设置'}
        </span>
      </div>
    </div>
  )
}

/* ------------------------------ 主面板 ------------------------------ */

export function SettingsPanel() {
  const { settings, patch, toast } = useApp()
  const [tab, setTab] = useState<'cloud' | 'interview' | 'llm' | 'stt' | 'hotkey' | 'window' | 'prompt' | 'memory' | 'privacy'>('cloud')
  const [promptKind, setPromptKind] = useState<'system' | 'screenshot' | 'transcript' | 'review'>('system')
  const [preview, setPreview] = useState<string>('')
  const [testing, setTesting] = useState<'llm' | 'stt' | null>(null)
  /**
   * 服务端放行的模型清单。**必须问服务端**，不能写死在客户端：
   * 网关对非白名单模型是静默改写的，客户端自己列一份就会出现
   * "下拉里选的是 A、实际跑的是 B"，而且不报错。见 `cloud.ts` 的 `clampModel`。
   */
  const [catalog, setCatalog] = useState<{ llm: string[]; asr: string[]; live: boolean; defaults: { llm: string; vision: string } } | null>(
    null
  )

  const loadCatalog = useCallback(async () => {
    const r = await api.cloudModels()
    if (r.ok && r.llm && r.asr && r.defaults) {
      setCatalog({ llm: r.llm, asr: r.asr, live: Boolean(r.live), defaults: r.defaults })
    }
  }, [])

  useEffect(() => {
    void loadCatalog()
  }, [loadCatalog])

  const llmModels = catalog?.llm?.length ? catalog.llm : CLOUD_LLM_MODELS
  const asrModels = catalog?.asr?.length ? catalog.asr : DASHSCOPE_MODELS

  const profile = useMemo<LLMProfile | undefined>(() => {
    const s = settings
    if (!s) return undefined
    return s.llm.profiles.find((p) => p.id === s.llm.activeProfileId) ?? s.llm.profiles[0]
  }, [settings])

  const updateProfile = useCallback(
    async (id: string, p: Partial<LLMProfile>) => {
      if (!settings) return
      const profiles = settings.llm.profiles.map((x) => (x.id === id ? { ...x, ...p } : x))
      await patch({ llm: { ...settings.llm, profiles } })
    },
    [settings, patch]
  )

  useEffect(() => {
    if (tab === 'prompt' && promptKind) {
      void api.promptPreview(promptKind).then((r) => setPreview(r.rendered))
    }
  }, [tab, promptKind])

  if (!settings) return <div className="panel muted">加载中…</div>

  const TABS: { id: typeof tab; name: string }[] = [
    // 账号放第一位：这一屏里用户最可能来做的就是看额度、兑兑换码
    { id: 'cloud', name: '账号' },
    { id: 'llm', name: '大模型' },
    { id: 'stt', name: '语音转写' },
    { id: 'interview', name: '面试信息' },
    { id: 'hotkey', name: '快捷键' },
    { id: 'window', name: '窗口' },
    { id: 'prompt', name: '提示词' },
    { id: 'memory', name: '记忆' },
    { id: 'privacy', name: '隐私' }
  ]

  return (
    <div className="body">
      <div className="tabs-inner" style={{ padding: '9px 11px 0' }}>
        {TABS.map((t) => (
          <button key={t.id} className={`btn sm ${tab === t.id ? 'primary' : 'ghost'}`} onClick={() => setTab(t.id)}>
            {t.name}
          </button>
        ))}
      </div>

      <div className="panel scroll" style={{ flex: 1, minHeight: 0 }}>
        {/* ------------------------------- 云端 ------------------------------- */}
        {tab === 'cloud' && <CloudPanel />}

        {/* ------------------------------ 大模型 ------------------------------ */}
        {tab === 'llm' && (
          <>
            <div className="section-title">对话模型</div>
            <div className="hint muted" style={{ marginBottom: 9 }}>
              模型由服务端统一提供，可用清单以服务端为准。上游密钥只存在于服务端，
              本机不保存、也无法填写。
            </div>

            {profile && (
              <>
                <div className="field">
                  <label>文本模型</label>
                  <select
                    className="select"
                    value={pickModel(profile.model, llmModels, catalog?.defaults?.llm ?? llmModels[0])}
                    onChange={(e) => void updateProfile(profile.id, { model: e.target.value })}
                  >
                    {llmModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  {!llmModels.includes(profile.model) && (
                    <div className="hint">
                      原配置里的「{profile.model || '（空）'}」不在服务端清单内，实际会使用上面选中的模型。
                    </div>
                  )}
                </div>

                <div className="field">
                  <label>视觉模型（截图分析）</label>
                  <select
                    className="select"
                    value={pickModel(profile.visionModel, llmModels, catalog?.defaults?.vision ?? llmModels[0])}
                    onChange={(e) => void updateProfile(profile.id, { visionModel: e.target.value })}
                  >
                    {llmModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>

                {catalog && !catalog.live && (
                  <div className="hint">
                    ⚠ 没能从服务端拉到模型清单，上面用的是内置清单，可能与服务端不一致。
                  </div>
                )}

                <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
                  <button className="btn sm ghost" onClick={() => void loadCatalog()}>
                    刷新模型清单
                  </button>
                  <button
                    className="btn primary sm"
                    disabled={testing === 'llm'}
                    onClick={async () => {
                      setTesting('llm')
                      const r = await api.llmTest()
                      setTesting(null)
                      toast(`${r.ok ? '✅' : '❌'} ${r.message}`, r.ok ? 'info' : 'error')
                    }}
                  >
                    {testing === 'llm' ? '测试中…' : '测试连接'}
                  </button>
                </div>

                <div className="divider" />
                <div className="section-title">采样参数</div>
                <div className="hint muted" style={{ marginBottom: 9 }}>
                  这些是体验参数，与"谁来付上游的钱"无关，因此仍然留在本机。
                </div>

                <Slider
                  label="温度"
                  value={profile.temperature}
                  min={0}
                  max={1.5}
                  step={0.05}
                  onChange={(v) => void updateProfile(profile.id, { temperature: v })}
                  format={(v) => v.toFixed(2)}
                />
                <div className="grid2">
                  <div className="field">
                    <label>最大 Token</label>
                    <input
                      className="input"
                      type="number"
                      value={profile.maxTokens}
                      onChange={(e) => void updateProfile(profile.id, { maxTokens: Number(e.target.value) })}
                    />
                  </div>
                  <div className="field">
                    <label>超时（毫秒）</label>
                    <input
                      className="input"
                      type="number"
                      value={profile.timeoutMs}
                      onChange={(e) => void updateProfile(profile.id, { timeoutMs: Number(e.target.value) })}
                    />
                  </div>
                </div>
                <Slider
                  label="失败重试次数"
                  value={profile.retries}
                  min={0}
                  max={5}
                  step={1}
                  onChange={(v) => void updateProfile(profile.id, { retries: v })}
                />
              </>
            )}
          </>
        )}

        {/* ------------------------------ 语音 ------------------------------ */}
        {tab === 'stt' && (
          <>
            <div className="section-title">语音转写</div>
            <div className="hint muted" style={{ marginBottom: 9 }}>
              转写由服务端提供的百炼通道完成，可用模型以服务端为准。
              上游密钥只存在于服务端，本机不保存、也无法填写。
            </div>

            <div className="grid2">
              <div className="field">
                <label>默认模型</label>
                <select
                  className="select"
                  value={pickModel(settings.stt.model, asrModels, asrModels[0])}
                  onChange={(e) => void patch({ stt: { ...settings.stt, model: e.target.value } })}
                >
                  {asrModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>采样率</label>
                <select
                  className="select"
                  value={settings.stt.sampleRate}
                  onChange={(e) => void patch({ stt: { ...settings.stt, sampleRate: Number(e.target.value) } })}
                >
                  <option value={16000}>16000 Hz（推荐）</option>
                  <option value={8000}>8000 Hz</option>
                </select>
              </div>
            </div>
            <div className="hint muted" style={{ marginTop: -4, marginBottom: 9 }}>
              通道没单独指定模型时用它；实时通道只能用带 <code>realtime</code> 的模型，离线通道反之。
            </div>

            <div className="field">
              <label>双通道采集</label>
              <div className="hint" style={{ marginBottom: 8 }}>
                两条通道是<strong>彼此独立的音频信号</strong>，各自采集、各自转写、各自配置模式。
                这正是「面试官提问要实时反馈、我自己的回答要事后整理」能同时成立的前提：
                混成一路只能二选一，分开之后各取所需。
              </div>

              {(['interviewer', 'candidate'] as const).map((ch) => {
                const cfg = settings.stt.channels[ch]
                const isInterviewer = ch === 'interviewer'
                return (
                  <div
                    key={ch}
                    style={{
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: 10,
                      marginBottom: 10
                    }}
                  >
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <input
                        type="checkbox"
                        checked={cfg.enabled}
                        onChange={(e) =>
                          void patch({
                            stt: {
                              ...settings.stt,
                              channels: { ...settings.stt.channels, [ch]: { ...cfg, enabled: e.target.checked } }
                            }
                          })
                        }
                      />
                      <strong>{isInterviewer ? '面试官通道（系统声音）' : '我的通道（麦克风）'}</strong>
                    </label>

                    <div className="hint" style={{ marginBottom: 8 }}>
                      {isInterviewer
                        ? '采集系统正在播放的声音（会议软件里对方的声音）。你的声音不会进入这一路，所以它天然只含面试官，无需任何说话人分离。首次使用需在弹出的选择框里勾选「分享音频」。'
                        : '采集你的麦克风。注意外放时面试官的声音会从扬声器串进这一路，所以它代表「我」的可信度弱于上一路。'}
                    </div>

                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <div className="field" style={{ flex: 1, minWidth: 180 }}>
                        <label>转写模式</label>
                        <select
                          className="select"
                          value={cfg.mode}
                          onChange={(e) =>
                            void patch({
                              stt: {
                                ...settings.stt,
                                channels: {
                                  ...settings.stt.channels,
                                  [ch]: { ...cfg, mode: e.target.value as 'realtime' | 'file' }
                                }
                              }
                            })
                          }
                        >
                          <option value="realtime">实时流式（低延迟，边录边出）</option>
                          <option value="file">停止后上传（高准确率，整段转写）</option>
                        </select>
                      </div>
                      <div className="field" style={{ flex: 1, minWidth: 180 }}>
                        <label>转写完成后</label>
                        <select
                          className="select"
                          value={cfg.sendMode}
                          onChange={(e) =>
                            void patch({
                              stt: {
                                ...settings.stt,
                                channels: {
                                  ...settings.stt.channels,
                                  [ch]: { ...cfg, sendMode: e.target.value as 'auto' | 'edit' | 'manual' }
                                }
                              }
                            })
                          }
                        >
                          <option value="auto">自动发送（立刻问 AI）</option>
                          <option value="edit">进输入框（可编辑后发送）</option>
                          <option value="manual">仅记录（不发问）</option>
                        </select>
                      </div>
                    </div>

                    {isInterviewer && (
                      <div className="hint">
                        建议保持<strong>实时流式 + 自动发送</strong>：面试官的问题一到就出答案，这是实时反馈的关键。
                      </div>
                    )}
                    {!isInterviewer && (
                      <div className="hint">
                        建议保持<strong>停止后上传 + 进输入框</strong>：整段上传的准确率明显高于流式，
                        更适合事后整理成知识点；也不会打断面试官的实时问答流。
                      </div>
                    )}
                  </div>
                )
              })}

              <div className="hint">
                录音时两路同时采集。若只想录其中一路（例如只想整理自己的回答），
                把另一路取消勾选即可，不影响已开启的那一路。
              </div>
            </div>


            <Slider
              label="VAD 静音阈值"
              value={settings.stt.vadThreshold}
              min={0.01}
              max={0.8}
              step={0.01}
              onChange={(v) => void patch({ stt: { ...settings.stt, vadThreshold: v } })}
              format={(v) => v.toFixed(2)}
            />
            <div className="field">
              <label>静音分段（毫秒）</label>
              <input
                className="input"
                type="number"
                value={settings.stt.vadSilenceMs}
                onChange={(e) => void patch({ stt: { ...settings.stt, vadSilenceMs: Number(e.target.value) } })}
              />
            </div>

            <div className="field">
              <label>音频格式</label>
              <select
                className="select"
                value={settings.stt.audioFormat}
                onChange={(e) =>
                  void patch({ stt: { ...settings.stt, audioFormat: e.target.value as 'pcm16' | 'wav' } })
                }
              >
                <option value="pcm16">PCM16（实时）</option>
                <option value="wav">WAV（离线）</option>
              </select>
            </div>

            <div className="field">
              <label>语言提示（中英混合，逗号分隔）</label>
              <input
                className="input"
                value={settings.stt.languageHints.join(',')}
                onChange={(e) =>
                  void patch({
                    stt: { ...settings.stt, languageHints: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) }
                  })
                }
              />
            </div>

            <Switch
              label="启用 ITN（数字/标点规范化）"
              on={settings.stt.enableITN}
              onChange={(v) => void patch({ stt: { ...settings.stt, enableITN: v } })}
            />

            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              <button
                className="btn primary sm"
                disabled={testing === 'stt'}
                onClick={async () => {
                  setTesting('stt')
                  const r = await api.sttTest()
                  setTesting(null)
                  toast(`${r.ok ? '✅' : '❌'} ${r.message}`, r.ok ? 'info' : 'error')
                }}
              >
                {testing === 'stt' ? '测试中…' : '测试语音通道'}
              </button>
            </div>
          </>
        )}

        {/* ------------------------------ 面试信息 ------------------------------ */}
        {tab === 'interview' && (
          <>
            <div className="section-title">本次面试上下文</div>
            <div className="hint muted" style={{ marginBottom: 9 }}>
              这些信息会填充到提示词的 {'{{company}}'} / {'{{role}}'} / {'{{jd}}'} 变量中。
            </div>
            <div className="grid2">
              <div className="field">
                <label>公司</label>
                <input
                  className="input"
                  value={settings.interview.company}
                  onChange={(e) => void patch({ interview: { ...settings.interview, company: e.target.value } })}
                />
              </div>
              <div className="field">
                <label>岗位</label>
                <input
                  className="input"
                  value={settings.interview.role}
                  onChange={(e) => void patch({ interview: { ...settings.interview, role: e.target.value } })}
                />
              </div>
            </div>
            <div className="field">
              <label>轮次</label>
              <input
                className="input"
                value={settings.interview.round}
                onChange={(e) => void patch({ interview: { ...settings.interview, round: e.target.value } })}
              />
            </div>
            <div className="field">
              <label>代码语言</label>
              <input
                className="input"
                list="code-lang-options"
                value={settings.interview.codeLang}
                placeholder="Java"
                onChange={(e) => void patch({ interview: { ...settings.interview, codeLang: e.target.value } })}
                onBlur={(e) => {
                  // 失焦时兜底，避免被清空后提示词里出现空语言
                  if (!e.target.value.trim()) {
                    void patch({ interview: { ...settings.interview, codeLang: 'Java' } })
                  }
                }}
              />
              <datalist id="code-lang-options">
                {CODE_LANGS.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
              <div className="hint muted">
                截图分析等场景要求写代码时统一用这个语言（填充提示词里的 <code>{'{{lang}}'}</code>）。留空则按 Java 处理。
              </div>
            </div>
            <div className="field">
              <label>职位描述 JD</label>
              <textarea
                className="input"
                style={{ minHeight: 120 }}
                value={settings.interview.jd}
                placeholder="粘贴 JD，AI 会针对性调整回答重点"
                onChange={(e) => void patch({ interview: { ...settings.interview, jd: e.target.value } })}
              />
            </div>
          </>
        )}

        {/* ------------------------------ 快捷键 ------------------------------ */}
        {tab === 'hotkey' && (
          <>
            <div className="section-title">全局快捷键</div>
            <div className="hint muted" style={{ marginBottom: 9 }}>
              点击右侧按钮后按下新组合键，Esc 取消。注册失败通常是被系统或其它软件占用。
            </div>
            <HotkeyRow action="toggleWindow" label="显示 / 隐藏窗口" value={settings.hotkeys.toggleWindow} />
            <HotkeyRow action="toggleClickThrough" label="鼠标穿透 / 可交互" value={settings.hotkeys.toggleClickThrough} />
            <HotkeyRow action="toggleAlwaysOnTop" label="切换始终置顶" value={settings.hotkeys.toggleAlwaysOnTop} />
            <HotkeyRow action="toggleRecording" label="开始 / 停止录音" value={settings.hotkeys.toggleRecording} />
            <HotkeyRow action="screenshot" label="一键截图分析" value={settings.hotkeys.screenshot} />
            <HotkeyRow action="panicHide" label="紧急隐藏" value={settings.hotkeys.panicHide} />
            <HotkeyRow action="panicMute" label="紧急静音" value={settings.hotkeys.panicMute} />
          </>
        )}

        {/* ------------------------------ 窗口 ------------------------------ */}
        {tab === 'window' && (
          <>
            <div className="section-title">窗口</div>
            <Slider
              label="背景不透明度"
              value={settings.window.opacity}
              min={0.2}
              max={1}
              step={0.01}
              onChange={(v) => void patch({ window: { ...settings.window, opacity: v } })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <div className="hint muted" style={{ marginTop: -6, marginBottom: 8 }}>
              只影响毛玻璃背景的浓淡，文字始终保持 100% 清晰；拖太低时背景会透出桌面。
            </div>
            <Switch
              label="始终置顶"
              on={settings.window.alwaysOnTop}
              onChange={(v) => void patch({ window: { ...settings.window, alwaysOnTop: v } })}
            />
            <div className="field">
              <label>置顶层级</label>
              <select
                className="select"
                value={settings.window.topLevel}
                onChange={(e) =>
                  void patch({ window: { ...settings.window, topLevel: e.target.value as 'normal' | 'floating' | 'screen-saver' } })
                }
              >
                <option value="screen-saver">最高（可在全屏应用之上显示）</option>
                <option value="floating">浮动</option>
                <option value="normal">普通</option>
              </select>
            </div>
            <Switch
              label="启动时默认鼠标穿透"
              on={settings.window.clickThroughDefault}
              onChange={(v) => void patch({ window: { ...settings.window, clickThroughDefault: v } })}
            />
            <Switch
              label="在任务栏显示"
              on={settings.window.showInTaskbar}
              onChange={(v) => void patch({ window: { ...settings.window, showInTaskbar: v } })}
            />

            <div className="divider" />
            <Switch
              label="屏幕共享时隐蔽（可选）"
              on={settings.window.stealthOnShare}
              onChange={(v) => {
                void patch({ window: { ...settings.window, stealthOnShare: v } })
                void api.windowAction('stealth', v)
              }}
            />
            <div className="hint muted">
              ⚠ 开启后系统会尽量把本窗口从屏幕共享/录屏中排除。请务必先确认该做法符合面试平台规则与公司规定，
              本工具定位为学习、模拟面试与个人辅助。
            </div>
            <div className="row" style={{ gap: 6, marginTop: 9 }}>
              <button className="btn sm ghost" onClick={() => void api.windowAction('moveToCursor')}>
                移到鼠标所在屏
              </button>
              <button className="btn sm ghost" onClick={() => void api.windowAction('toggleCollapse')}>
                折叠 / 展开
              </button>
            </div>
          </>
        )}

        {/* ------------------------------ 提示词 ------------------------------ */}
        {tab === 'prompt' && (
          <>
            <div className="section-title">提示词编辑</div>
            <div className="tabs-inner">
              {(
                [
                  ['system', '系统提示词'],
                  ['transcript', '语音转录'],
                  ['screenshot', '截图分析'],
                  ['review', '面试复盘']
                ] as const
              ).map(([k, n]) => (
                <button
                  key={k}
                  className={`btn sm ${promptKind === k ? 'primary' : 'ghost'}`}
                  onClick={() => setPromptKind(k)}
                >
                  {n}
                </button>
              ))}
            </div>

            <textarea
              className="input editor"
              value={settings.prompts[promptKind]}
              onChange={(e) => void patch({ prompts: { ...settings.prompts, [promptKind]: e.target.value } })}
            />

            <div className="hint muted" style={{ marginTop: 6 }}>
              可用变量：{'{{company}}'} {'{{role}}'} {'{{jd}}'} {'{{round}}'} {'{{transcript}}'} {'{{knowledge}}'}{' '}
              {'{{memory}}'} {'{{lang}}'} {'{{material}}'}。修改后立即生效。
            </div>

            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              <button
                className="btn sm"
                onClick={() => void api.promptPreview(promptKind).then((r) => setPreview(r.rendered))}
              >
                渲染预览
              </button>
              <button className="btn sm ghost" onClick={() => setPreview('')}>
                清除预览
              </button>
            </div>
            {preview && <div className="preview" style={{ marginTop: 8 }}>{preview}</div>}
          </>
        )}

        {/* ------------------------------ 记忆 ------------------------------ */}
        {tab === 'memory' && (
          <>
            <div className="section-title">记忆与复盘</div>
            <Switch
              label="启用记忆库"
              on={settings.memory.enabled}
              onChange={(v) => void patch({ memory: { ...settings.memory, enabled: v } })}
            />
            <Switch
              label="结束面试后自动复盘"
              on={settings.memory.autoReview}
              onChange={(v) => void patch({ memory: { ...settings.memory, autoReview: v } })}
            />
            <Switch
              label="复盘时排除敏感内容（薪资/加班等）"
              on={settings.memory.excludeSensitive}
              onChange={(v) => void patch({ memory: { ...settings.memory, excludeSensitive: v } })}
            />
            <Slider
              label="自动注入记忆条数 topK"
              value={settings.memory.retrievalTopK}
              min={0}
              max={15}
              step={1}
              onChange={(v) => void patch({ memory: { ...settings.memory, retrievalTopK: v } })}
            />
            <div className="field">
              <label>复习间隔（天，逗号分隔）</label>
              <input
                className="input"
                value={settings.memory.reviewIntervals.join(',')}
                onChange={(e) =>
                  void patch({
                    memory: {
                      ...settings.memory,
                      reviewIntervals: e.target.value
                        .split(',')
                        .map((x) => Number(x.trim()))
                        .filter((x) => x > 0)
                    }
                  })
                }
              />
              <div className="hint">基于遗忘曲线的间隔重复：答对进入下一档，答错回到第 1 天。</div>
            </div>
            <div className="field">
              <label>保留天数</label>
              <input
                className="input"
                type="number"
                value={settings.memory.retentionDays}
                onChange={(e) => void patch({ memory: { ...settings.memory, retentionDays: Number(e.target.value) } })}
              />
              <div className="hint">
                超过该天数的记忆条目与<b>面试历史</b>会在启动时清理（面试记录每场都会存下全部转写与回答，
                不设上限会一直膨胀）。默认 365 天。
              </div>
            </div>
          </>
        )}

        {/* ------------------------------ 隐私 ------------------------------ */}
        {tab === 'privacy' && (
          <>
            <div className="section-title">隐私</div>
            <Switch
              label="仅本地存储（不同步云端）"
              on={settings.privacy.localOnly}
              onChange={(v) => void patch({ privacy: { ...settings.privacy, localOnly: v } })}
            />
            <Switch
              label="保存转写文本（用于复盘）"
              on={settings.privacy.persistTranscript}
              onChange={(v) => void patch({ privacy: { ...settings.privacy, persistTranscript: v } })}
            />
            <Switch
              label="保存音频文件"
              on={settings.privacy.persistAudio}
              onChange={(v) => void patch({ privacy: { ...settings.privacy, persistAudio: v } })}
            />
            <div className="hint muted">音频默认不落盘，仅在内存中转写后丢弃。</div>

            <div className="divider" />
            <div className="row wrap" style={{ gap: 6 }}>
              <button className="btn sm ghost" onClick={() => void api.openUserData()}>
                打开数据目录
              </button>
              <button className="btn sm ghost" onClick={() => void api.kbOpenDir()}>
                打开知识库目录
              </button>
              <button
                className="btn sm danger"
                onClick={async () => {
                  const ok = window.confirm(
                    '将永久删除：\n' +
                      '· 全部记忆库条目\n' +
                      '· 全部面试会话及其语音转写全文\n' +
                      '· 正在进行的会话与缓存截图\n\n' +
                      '知识库 Markdown 不会被删除。此操作不可撤销，确定继续吗？'
                  )
                  if (!ok) return
                  try {
                    await api.clearAll()
                    toast('已清除记忆库、全部面试会话与缓存截图', 'info')
                  } catch (err) {
                    toast(`清除失败：${(err as Error).message}`, 'error')
                  }
                }}
              >
                一键清除全部历史
              </button>
            </div>
            <div className="hint muted" style={{ marginTop: 9 }}>
              数据位置：{settings.paths.userData}
              <br />
              知识库：{settings.paths.knowledge}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
