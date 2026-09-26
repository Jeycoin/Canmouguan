import type { CanmouguanAPI } from '../electron/preload'
import type { Settings } from '../electron/shared/types'

declare global {
  interface Window {
    canmouguan: CanmouguanAPI
  }
}

export const api = window.canmouguan

/* --------------------------------- 类型再导出 --------------------------------- */

export type {
  Settings,
  LLMProfile,
  STTSettings,
  CloudSettings,
  CloudQuota,
  HotkeySettings,
  WindowSettings,
  PromptSettings,
  MemorySettings,
  PrivacySettings,
  KnowledgeDoc,
  KnowledgeHit,
  MemoryItem,
  MasteryLevel,
  ChatMessage,
  InterviewSession,
  TestResult
} from '../electron/shared/types'

/**
 * 只再导出一张"兜底"模型表。
 *
 * `LLM_PRESETS` / `DASHSCOPE_ENDPOINTS`（BYOK 时代的供应商与端点预设）**刻意不再导出**：
 * 界面已全部移除，留着只会让后来的人以为"还能填自己的 Key"。
 * 它们在 `types.ts` 里仍标着 `@deprecated` 保留着，恢复 BYOK 时可直接取用。
 * 模型清单以服务端为准（`api.cloudModels()`），这里只用于拉不到时的兜底显示。
 */
export { CLOUD_LLM_MODELS, DASHSCOPE_MODELS, DEFAULT_GATEWAY_URL } from '../electron/shared/types'

export type AppSettings = Settings & { paths: { userData: string; knowledge: string } }

/** 主进程可推送的事件通道（与 preload 白名单对齐） */
export type IPCChannel = Parameters<typeof api.on>[0]

/* ------------------------------ 事件订阅助手 ------------------------------ */

export function on<T = unknown>(channel: IPCChannel, cb: (payload: T) => void): () => void {
  const handler = (payload: T) => cb(payload)
  return api.on(channel, handler as never)
}
