import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping'

/** 采集通道：与主进程 / 类型定义里的 STTChannel 一致 */
export type ChannelName = 'interviewer' | 'candidate'

const SAMPLE_RATE = 16000

/** 每个通道各自的录音状态与电平，UI 需要分别展示 */
export interface ChannelRuntime {
  active: boolean
  level: number
}

interface UseRecorderOptions {
  /** 需要开启的通道（由设置决定），空数组表示不采集 */
  channels: ChannelName[]
  onError?: (msg: string) => void
  /** 某个通道采集失败时的回调（用于提示"只录到了一路"） */
  onChannelError?: (channel: ChannelName, message: string) => void
}

/** 单通道的采集资源，两台设备各自独立一套 */
interface ChannelPipeline {
  ctx: AudioContext
  proc: AudioWorkletNode
  streams: MediaStream[]
  source: MediaStreamAudioSourceNode
}

async function openStream(channel: ChannelName): Promise<MediaStream> {
  if (channel === 'interviewer') {
    /*
     * 面试官的声音 = 系统正在播放的声音 → 必须走屏幕采集的 loopback。
     *
     * 关键：**不要**在这里 stop 视频轨以外的处理上偷懒，
     * 但也绝不能保留视频轨 —— 它会持续编码整个屏幕，纯属浪费。
     * 只取音频轨、立刻停掉视频轨，是这里唯一正确的做法。
     */
    const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    disp.getVideoTracks().forEach((t) => t.stop())
    if (!disp.getAudioTracks().length) {
      throw new Error('系统声音捕获失败：请在弹出的选择框里勾选「分享音频」')
    }
    return disp
  }

  /*
   * 我自己的声音 = 麦克风。
   *
   * 这里刻意**不同**于旧实现：不再做任何混音（createGain 合并两路），
   * 因为两路信号一旦相加就再也分不开说话人了 —— 而说话人区分正是本功能的全部意义。
   * 也因此这里不需要 echoCancellation 之外的妥协：这一路只代表"我"。
   */
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    },
    video: false
  })
}

/**
 * 双通道采集 → 各通道独立重采样到 16kHz 单声道 PCM16 → 分别推给主进程。
 *
 * 两条通道是**完全独立**的 AudioContext + AudioWorklet 链路，互不干扰：
 * - `interviewer`：系统回环，天然只含面试官，用于实时问答；
 * - `candidate`：麦克风，只含我自己，用于事后整理成知识点。
 *
 * 为什么必须分开而不是先混音再采集：混音是**不可逆**的，
 * 一旦相加就无法再区分说话人，复盘的 myAnswer / mastery 会全部失准。
 */
export function useRecorder({ channels, onError, onChannelError }: UseRecorderOptions) {
  const [state, setState] = useState<RecorderState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [muted, setMuted] = useState(false)
  const [channelState, setChannelState] = useState<Record<string, ChannelRuntime>>({})

  const pipesRef = useRef<Partial<Record<ChannelName, ChannelPipeline>>>({})
  const timerRef = useRef<number | null>(null)
  const mutedRef = useRef(false)
  const channelsRef = useRef<ChannelName[]>(channels)

  channelsRef.current = channels
  mutedRef.current = muted

  const setChannel = useCallback((channel: ChannelName, patch: Partial<ChannelRuntime>) => {
    setChannelState((prev) => {
      const base: ChannelRuntime = prev[channel] ?? { active: false, level: 0 }
      return { ...prev, [channel]: { ...base, ...patch } }
    })
  }, [])

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    for (const pipe of Object.values(pipesRef.current)) {
      if (!pipe) continue
      try {
        pipe.proc.disconnect()
      } catch {
        /* noop */
      }
      try {
        pipe.source.disconnect()
      } catch {
        /* noop */
      }
      for (const s of pipe.streams) {
        s.getTracks().forEach((t) => {
          try {
            t.stop()
          } catch {
            /* noop */
          }
        })
      }
      if (pipe.ctx.state !== 'closed') void pipe.ctx.close()
    }
    pipesRef.current = {}
    setChannelState({})
  }, [])

  /** 建立一条通道的完整链路（解码 → worklet → IPC） */
  const buildPipeline = useCallback(
    async (channel: ChannelName): Promise<ChannelPipeline> => {
      const stream = await openStream(channel)
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
      const source = ctx.createMediaStreamSource(stream)

      /*
       * 必须用「文档相对路径」，不能写绝对路径 '/recorder-worklet.js'。
       *
       * 打包后渲染层是 loadFile 出来的 file:///…/app.asar/dist/index.html，
       * 绝对路径会解析到磁盘根目录（file:///recorder-worklet.js）→ 文件不存在 →
       * addModule 抛错 → 录音整条链路不可用。
       * 而 dev（http://127.0.0.1:5173/）和 smoke（本地静态服务）的 index.html 都在站点根，
       * 绝对路径恰好能用 —— 所以这个 bug 只在打包产物里出现，开发时测不到。
       *
       * 注意：两条通道**各自**调用 addModule 是必要的（AudioContext 相互独立），
       * 浏览器会缓存同一个 URL 的编译结果，没有重复下载的代价。
       */
      await ctx.audioWorklet.addModule(new URL('recorder-worklet.js', document.baseURI).href)

      const proc = new AudioWorkletNode(ctx, 'recorder-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit'
      })

      proc.port.onmessage = (e) => {
        const { pcm, length } = e.data as { pcm: ArrayBuffer; length: number }

        if (mutedRef.current) {
          // 静音：仍推等长静音帧，保持服务端时间轴连续，但不上传任何真实音频
          api.sttAudio(channel, new Int16Array(length).buffer)
          setChannel(channel, { level: 0 })
          return
        }

        const view = new Int16Array(pcm, 0, length)
        let sum = 0
        for (let i = 0; i < view.length; i++) {
          const sample = view[i]
          const v = sample < 0 ? sample / 0x8000 : sample / 0x7fff
          sum += v * v
        }
        // 注意：这里刻意不在本地累积 PCM。离线模式所需的完整音频由主进程
        // 各通道的 pcmChunks 持有；渲染层若再存一份，长录音会以约 64KB/s 泄漏（双通道翻倍）。
        const rms = Math.sqrt(sum / Math.max(1, length))
        setChannel(channel, { level: Math.min(1, rms * 3.2) })
        api.sttAudio(channel, pcm)
      }

      source.connect(proc)
      return { ctx, proc, streams: [stream], source }
    },
    [setChannel]
  )

  const start = useCallback(async () => {
    if (state === 'recording' || state === 'starting') return
    setState('starting')
    setElapsed(0)

    const wanted = channelsRef.current
    if (!wanted.length) {
      setState('idle')
      onError?.('没有启用任何采集通道（设置 → 语音识别）')
      return
    }

    try {
      /*
       * 先建链路、再让主进程开转写。
       *
       * 顺序反了会丢开头几帧：主进程会话已就绪但音频还没上来，
       * 而面试官开口的第一句话恰恰是最重要的。
       */
      const ready: ChannelName[] = []
      const failed: { channel: ChannelName; message: string }[] = []

      for (const ch of wanted) {
        try {
          pipesRef.current[ch] = await buildPipeline(ch)
          ready.push(ch)
        } catch (err) {
          failed.push({ channel: ch, message: (err as Error).message })
        }
      }

      if (!ready.length) throw new Error(failed[0]?.message ?? '没有可用的音频输入源')

      // 部分通道失败不阻塞另一条：能录到一半远好过全丢
      for (const f of failed) {
        onChannelError?.(
          f.channel,
          `${f.channel === 'interviewer' ? '系统声音' : '麦克风'}采集失败：${f.message}`
        )
      }

      await api.sttStart()

      for (const ch of ready) setChannel(ch, { active: true })
      setState('recording')
      timerRef.current = window.setInterval(() => setElapsed((v) => v + 1), 1000)
    } catch (err) {
      cleanup()
      setState('idle')
      onError?.((err as Error).message || '录音启动失败')
    }
  }, [state, buildPipeline, cleanup, onError, onChannelError, setChannel])

  const stop = useCallback(async () => {
    if (state !== 'recording') return null
    setState('stopping')
    // 让尾部音频再走一帧（file 模式下这段尤其重要，最后半句很容易被切掉）
    await new Promise((r) => setTimeout(r, 220))
    cleanup()
    setState('idle')
    return api.sttStop()
  }, [state, cleanup])

  const toggle = useCallback(() => {
    if (state === 'recording') void stop()
    else void start()
  }, [state, start, stop])

  const panicMute = useCallback(() => {
    setMuted(true)
    for (const pipe of Object.values(pipesRef.current)) {
      pipe?.streams.forEach((s) => s.getAudioTracks().forEach((t) => (t.enabled = false)))
    }
  }, [])

  const unmute = useCallback(() => {
    setMuted(false)
    for (const pipe of Object.values(pipesRef.current)) {
      pipe?.streams.forEach((s) => s.getAudioTracks().forEach((t) => (t.enabled = true)))
    }
  }, [])

  useEffect(() => cleanup, [cleanup])

  /** 兼容旧 UI：整体电平取两路的较大值，哪边有人在说都能看出来 */
  const level = Math.max(0, ...Object.values(channelState).map((c) => c.level ?? 0))

  return { state, level, elapsed, muted, start, stop, toggle, panicMute, unmute, channelState }
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
