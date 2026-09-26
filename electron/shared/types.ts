/**
 * 主进程 / 渲染进程共享类型定义
 */

/* ------------------------------ 供应商预设 ------------------------------ */

/**
 * @deprecated **自带 Key 时代的供应商预设，界面已全部移除**。
 *
 * 保留整块（含下面的 `LLM_PRESETS` / `DASHSCOPE_ENDPOINTS`）是刻意的：
 * 它不含任何秘密，只是一张静态表，留着以后要恢复 BYOK 时不用重新查各家 Base URL。
 * 主进程与渲染进程都**不再引用**它们 —— 引用了才会让人以为 BYOK 还活着。
 */
export interface ProviderPreset {
  id: string
  name: string
  baseURL: string
  model: string
  visionModel?: string
}

export const LLM_PRESETS: ProviderPreset[] = [
  {
    id: 'zhipu',
    name: '智谱 BigModel',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3-flash',
    // GLM-5.3-Flash 原生多模态，文本/视觉同一个模型
    // ⚠️ 实测：它属于「强制思考」型（官方明确不支持关闭 thinking，只接受 low/high/max）。
    //    单纯问一句话：思考链约 2000 字、首个正文 7.2s、总耗时 9.3s；
    //    带一张 350KB 截图约 28-37s 且可能整段不出正文。
    //    做面试实时辅助请优先选下面的「智谱 · 极速」组合。
    visionModel: 'glm-5.3-flash'
  },
  {
    id: 'zhipu-fast',
    name: '智谱 · 极速（面试实时推荐）',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    // 实测：纯文本首字 675ms / 总 2.2s；带图首字 994ms / 总 2.3s，且无思考链开销
    visionModel: 'glm-4v-flash'
  },
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', visionModel: 'gpt-4o' },
  { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  {
    id: 'qwen',
    name: '通义千问（OpenAI 兼容模式）',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    visionModel: 'qwen-vl-max-latest'
  },
  { id: 'moonshot', name: 'Moonshot / Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { id: 'ollama', name: 'Ollama（本地）', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  { id: 'custom', name: '自定义', baseURL: '', model: '' }
]

export const STT_PRESETS = [
  { id: 'dashscope', name: '阿里云百炼 DashScope', model: 'paraformer-realtime-v2' }
]

export const DASHSCOPE_MODELS = [
  'paraformer-realtime-v2',
  'paraformer-realtime-v1',
  'paraformer-realtime-8k-v2',
  'paraformer-v2',
  'paraformer-8k-v2',
  'sensevoice-v1'
]

export const DASHSCOPE_ENDPOINTS = [
  { id: 'beijing', name: '北京（公有云）', ws: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/', http: 'https://dashscope.aliyuncs.com' },
  { id: 'intl', name: '国际（新加坡）', ws: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference/', http: 'https://dashscope-intl.aliyuncs.com' }
]

/* ------------------------------- 云端账号 ------------------------------- */

/**
 * 网关返回的额度快照。
 *
 * ⚠️ **仅用于界面展示**。放行与否永远由服务端决定 ——
 * 这里有"剩余 10 小时"不代表真能用，用户可以改内存里的这个数字。
 */
export interface CloudQuota {
  account: string
  plan: string
  planName: string
  /** 付费会员是否仍在有效期内（过期后服务端会回落成免费额度） */
  paidActive: boolean
  planExpiresAt: number | null
  asr: { used: number; limit: number; remaining: number }
  llm: { used: number; limit: number; remaining: number; tokens: number }
  /** 距下期重置还有多久（毫秒）；免费额度是终身一次性，为 null */
  resetInMs: number | null
}

/**
 * 云端模式配置。
 *
 * ⚠️ **运行形态只有一种：全部走自建网关（`server/`）**。
 * LLM 与语音都不再由客户端直连上游，本地也不持有任何上游 Key ——
 * 这是"卖会员"这个商业模式的技术前提：上游 Key 一旦下发到客户端，
 * 配额就形同虚设（用户可以绕过你的服务直连上游）。
 *
 * 所以这里是**强制项**，不是可选项：主进程里没有任何"要不要走网关"的分支。
 */
export interface CloudSettings {
  /**
   * @deprecated 已经没有"云端模式开关"这回事了 —— 恒为 `true`。
   * 字段保留只为让老 settings.json 的格式继续成立；**不要**再拿它做判断，
   * 那会让"改了开关没反应"重现。
   */
  enabled: boolean
  /**
   * 网关地址，如 `https://canmouguan.cloud`。
   * **不要带 `/v1` 后缀** —— 各端点在代码里各自拼接。
   * 留空则回落 `DEFAULT_GATEWAY_URL`（本机自部署）。
   */
  baseURL: string
  /** 加密后的登录 token（safeStorage）；与 API Key 同等对待，明文永不落盘 */
  tokenEnc?: string
  /** 仅下发到 UI：是否已登录（不暴露 token 任何片段） */
  hasToken?: boolean
  /** 仅下发到 UI：最近一次同步到的账号与额度 */
  lastMe?: CloudQuota | null
}

/**
 * 云端模式的默认模型。
 *
 * 必须落在网关的 LLM 白名单内（`server/lib/env.js` 的 `LLM_ALLOWED_MODELS`），
 * 否则会被网关**改写成它自己的默认模型** —— 不会报错，但用户会疑惑"为什么选的是 A 用的是 B"。
 * 这里沿用实测最快的非思考模型（见 §13 模型选型）。
 */
export const CLOUD_LLM_MODEL = 'glm-4-flash'
export const CLOUD_LLM_VISION_MODEL = 'glm-4v-flash'

/** 网关默认放行的模型。网关可用 `CMG_LLM_MODELS` 覆盖，所以这里只作 UI 提示用。 */
export const CLOUD_LLM_MODELS = ['glm-4-flash', 'glm-4v-flash', 'glm-4-plus', 'glm-4-air', 'glm-4v', 'glm-4']

/**
 * 网关地址的默认值：本机自部署。
 *
 * 为什么给默认值而不是"留空等用户填"：现在**没有**BYOK 这条退路 ——
 * 留空就等于"装完打开就是死的，只给一句'尚未填写网关地址'"。
 * 本机默认值让 `npm start`（server 目录）一跑起来客户端就能连上，
 * 正式发布时由安装包或用户在登录页改掉。
 */
export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8787'

/* --------------------------------- 设置 --------------------------------- */

export interface LLMProfile {
  id: string
  name: string
  /**
   * @deprecated **主进程已不再读取**（落点恒为网关）。
   * 保留是为了一旦要恢复"自带 Key"模式，只需恢复界面即可，不用动 schema。
   */
  baseURL: string
  model: string
  visionModel: string
  temperature: number
  maxTokens: number
  timeoutMs: number
  retries: number
  /**
   * @deprecated **主进程已不再读取**。自带 Key 的写入通道已从界面移除；
   * 详见 `electron/main/cloud.ts` 顶部说明。
   */
  apiKeyEnc?: string
  /** @deprecated 仅下发到 UI 的旧字段，界面已不再显示 */
  hasKey?: boolean
}

/**
 * 采集通道 = 说话人角色在此系统里的物理实现。
 *
 * 这两个通道对应**两条独立的音频信号**，也是整个语音链路的第一性划分：
 * - `interviewer`：系统声音回环（对方在会议软件里的声音）。候选人的声音不会进回环，
 *   所以这一路**天然只包含面试官**，不需要任何说话人分离。
 * - `candidate`：麦克风（我自己）。外放时面试官的声音会从扬声器串进来，
 *   所以这一路的可信度要弱一些。
 *
 * 为什么必须分通道而不是混成一路：两条链路的延迟需求是相反的 ——
 * 面试官提问要**实时**（realtime + 自动发送），我自己的回答要**准确**（file 整段上传），
 * 混在一起就只能二选一。分通道后各自独立配置、独立启停、独立落库。
 */
export type STTChannel = 'interviewer' | 'candidate'

/** 每个通道独立的转写配置：模式与发送策略由"这条链路要什么"决定 */
export interface STTChannelConfig {
  enabled: boolean
  /** realtime = 边录边转（低延迟）；file = 停止后整段上传（高准确率） */
  mode: 'realtime' | 'file'
  /** 该通道转写完成后如何处理 */
  sendMode: 'auto' | 'edit' | 'manual'
  /** 该通道的实时模型（realtime 模式用） */
  realtimeModel: string
  /** 该通道的离线模型（file 模式用） */
  fileModel: string
}

export interface STTSettings {
  /**
   * @deprecated **主进程已不再读取**（语音落点恒为网关）。
   * 保留是为了"恢复自带 Key 模式只需恢复界面"，不用动 schema。
   */
  apiKeyEnc?: string
  /** @deprecated 仅下发到 UI 的旧字段，界面已不再显示 */
  hasKey?: boolean
  /**
   * @deprecated **主进程已不再读取**（网关固定走北京公有云端点）。
   * 保留原因同上。
   */
  endpointId: string
  /** 兜底模型：通道未指定 realtimeModel / fileModel 时用它 */
  model: string
  /**
   * @deprecated 通道化之后模式由 `channels.*.mode` 决定。
   * 保留仅为兼容旧 settings.json，读取时用作通道默认值。
   */
  mode: 'realtime' | 'file'
  sampleRate: number
  audioFormat: 'pcm16' | 'wav'
  vadThreshold: number
  /** 静音多少毫秒后自动分段 */
  vadSilenceMs: number
  languageHints: string[]
  /**
   * @deprecated 双通道采集后两路信号永远分开，不再需要"混音"这个选项。
   * 保留仅为兼容旧 settings.json（'both' 会被迁移成两通道都开）。
   */
  audioSource: 'mic' | 'system' | 'both'
  /**
   * @deprecated 发送策略已下放到每个通道（`channels.*.sendMode`）。
   * 保留仅为兼容旧 settings.json，迁移时用它初始化两个通道。
   */
  sendMode: 'auto' | 'edit' | 'manual'
  /** 双通道采集配置：面试官 / 候选人各一条独立链路 */
  channels: Record<STTChannel, STTChannelConfig>
  enableITN: boolean
  enablePunctuation: boolean
}

/** 双通道的默认配置：正是"实时听问题 + 事后整理回答"这一诉求的落地 */
export function defaultChannelConfigs(): Record<STTChannel, STTChannelConfig> {
  return {
    // 面试官提问：要实时反馈 → 流式、自动发送
    interviewer: {
      enabled: true,
      mode: 'realtime',
      sendMode: 'auto',
      realtimeModel: 'paraformer-realtime-v2',
      fileModel: 'paraformer-v2'
    },
    // 我自己的回答：要事后整理成知识点 → 停止后整段上传（准确率更高）、进输入框可编辑
    candidate: {
      enabled: true,
      mode: 'file',
      sendMode: 'edit',
      realtimeModel: 'paraformer-realtime-v2',
      fileModel: 'paraformer-v2'
    }
  }
}

export interface HotkeySettings {
  toggleWindow: string
  toggleClickThrough: string
  toggleAlwaysOnTop: string
  toggleRecording: string
  screenshot: string
  panicHide: string
  panicMute: string
}

export interface WindowSettings {
  opacity: number
  alwaysOnTop: boolean
  topLevel: 'normal' | 'floating' | 'screen-saver'
  clickThroughDefault: boolean
  width: number
  height: number
  x?: number
  y?: number
  /** 屏幕共享时隐蔽（可选能力，需用户自行确认合规性） */
  stealthOnShare: boolean
  showInTaskbar: boolean
}

export interface PromptSettings {
  system: string
  screenshot: string
  transcript: string
  review: string
  knowledgeInjection: string
  memoryInjection: string
}

export interface MemorySettings {
  autoReview: boolean
  retrievalTopK: number
  /** 间隔重复复习间隔（天） */
  reviewIntervals: number[]
  retentionDays: number
  enabled: boolean
  excludeSensitive: boolean
}

export interface PrivacySettings {
  localOnly: boolean
  persistAudio: boolean
  persistTranscript: boolean
}

export interface InterviewMeta {
  company: string
  role: string
  jd: string
  round: string
  /** 代码题回答使用的语言，渲染到提示词的 {{lang}} 变量 */
  codeLang: string
}

export interface Settings {
  version: number
  llm: {
    activeProfileId: string
    profiles: LLMProfile[]
  }
  stt: STTSettings
  /** 云端模式：走自建网关，本地不持上游 Key */
  cloud: CloudSettings
  hotkeys: HotkeySettings
  window: WindowSettings
  prompts: PromptSettings
  memory: MemorySettings
  privacy: PrivacySettings
  interview: InterviewMeta
  knowledgeDir: string
}

/* ------------------------------- 知识库 -------------------------------- */

export interface KnowledgeDoc {
  id: string
  path: string
  title: string
  category: string
  tags: string[]
  content: string
  updatedAt: number
  size: number
}

export interface KnowledgeHit {
  doc: KnowledgeDoc
  score: number
  /** 命中的片段（用于注入提示词） */
  snippet: string
}

/* -------------------------------- 记忆库 -------------------------------- */

export type MasteryLevel = 0 | 1 | 2 | 3 | 4 | 5

export interface MemoryItem {
  id: string
  /** 面试问题 */
  question: string
  /** 考察知识点 */
  knowledgePoints: string[]
  /** 标准答案 / 参考思路 */
  referenceAnswer: string
  /** 我的回答摘要 */
  myAnswer: string
  /** 暴露的薄弱点 */
  weakPoints: string[]
  /** 改进建议 */
  suggestions: string
  tags: string[]
  mastery: MasteryLevel
  source: {
    company: string
    role: string
    round: string
    at: number
    sessionId: string
  }
  createdAt: number
  updatedAt: number
  /** 间隔重复：下次复习时间戳 */
  nextReviewAt: number
  reviewStage: number
  reviewCount: number
  lastReviewResult?: 'mastered' | 'fuzzy' | 'unknown'
}

export interface InterviewSession {
  id: string
  company: string
  role: string
  round: string
  startedAt: number
  endedAt?: number
  /**
   * 转写条目。`speaker` 是**说话人角色**，和音频设备无关：
   *   interviewer = 对方（面试官）说的；candidate = 我（候选人）说的；
   *   mixed = 单路混音无法区分（audioSource=both，或旧数据没有该字段）。
   *
   * 为什么不是按设备区分：麦克风里同样能收到面试官从扬声器漏出来的声音，
   * 设备维度切不出说话人。区分靠的是「采集来源」或模型的说话人分离。
   */
  transcripts: { at: number; text: string; source: string; speaker?: 'interviewer' | 'candidate' | 'mixed' }[]
  screenshots: { at: number; note?: string }[]
  aiAnswers: { at: number; text: string }[]
}

/* --------------------------------- 对话 --------------------------------- */

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  at: number
  /** 用于 UI 展示的附加信息 */
  kind?: 'transcript' | 'screenshot' | 'knowledge' | 'review' | 'text'
  /** 该消息来自哪条采集通道；用来在界面上区分"面试官说的"和"我说的" */
  channel?: STTChannel
  imageDataUrl?: string
  streaming?: boolean
  error?: string
}

/* ------------------------------- STT 事件 ------------------------------- */

export type STTState = 'idle' | 'connecting' | 'listening' | 'processing' | 'error'

export interface STTPartialEvent {
  text: string
  /** 是否为稳定（不再变化）的句子 */
  stable: boolean
  sentenceEnd: boolean
}

/* -------------------------------- IPC --------------------------------- */

export interface IPCError {
  code: string
  message: string
  detail?: string
}

export interface TestResult {
  ok: boolean
  message: string
  latencyMs?: number
}
