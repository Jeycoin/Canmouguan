/**
 * AudioWorklet processor: 16kHz 单声道 float32 -> PCM16。
 *
 * 关键点是 **攒够一帧再发**：AudioWorklet 的 process() 每 128 个样本触发一次
 * （16kHz 下 = 8ms），如果每次都 postMessage + IPC 到主进程，就是每秒 125 条
 * IPC 消息，序列化开销远超音频数据量本身。这里攒到 BUFFER_SAMPLES 再发一次，
 * 把 IPC 频率降到十分之一，代价只是 100ms 的额外延迟（实时转写下无感知）。
 */
const BUFFER_SAMPLES = 1600 // 100ms @ 16kHz

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Int16Array(BUFFER_SAMPLES)
    this.filled = 0
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    // 输入断开（设备拔出 / Track 停止）：把残留的一小段先送出去，避免丢尾音
    if (!input || input.length === 0) {
      this.flush()
      return true
    }

    for (let i = 0; i < input.length; i++) {
      const s = input[i]
      const c = s < -1 ? -1 : s > 1 ? 1 : s
      this.buf[this.filled++] = c < 0 ? c * 0x8000 : c * 0x7fff
      if (this.filled === BUFFER_SAMPLES) this.flush()
    }
    return true
  }

  flush() {
    if (!this.filled) return
    // slice 会分配独立 ArrayBuffer，因此可以安全 transfer 出去
    const out = this.buf.slice(0, this.filled)
    const length = out.length
    this.filled = 0
    this.port.postMessage({ pcm: out.buffer, length }, [out.buffer])
  }
}

registerProcessor('recorder-processor', RecorderProcessor)
