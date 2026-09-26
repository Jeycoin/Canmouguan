import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { LLMProfile, Settings } from '../shared/types'
import { defaultChannelConfigs, DEFAULT_GATEWAY_URL } from '../shared/types'
import { getLegacyUserDataDirs } from './appdir'

export const SETTINGS_VERSION = 5

export function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

export function getUserDataDir(): string {
  return app.getPath('userData')
}

/** 知识库默认目录：首次运行会写入示例文档 */
export function getDefaultKnowledgeDir(): string {
  return path.join(app.getPath('userData'), 'knowledge')
}

function defaultPrompts(): Settings['prompts'] {
  return {
    system: `你是一名顶级的面试辅助助手，正在帮助候选人在真实面试/模拟面试中给出高质量回答。
你的输出必须：
1. 直接可用：给出候选人可以口头说出来的内容，而不是"你可以这样回答"。
2. 结构化：先给一句话结论，再给 3-5 个要点，需要写代码时一律使用 {{lang}}。
3. 贴合上下文：优先使用 {{knowledge}} 与 {{memory}} 中提供的真实经历与历史薄弱点。
4. 诚实：知识库没有的信息不要编造，用"这段经历可以替换为你自己的 X"标注。

当前上下文：
- 公司：{{company}}
- 岗位：{{role}}
- 轮次：{{round}}
- 代码语言：{{lang}}
- 职位描述（JD）：{{jd}}

候选人的知识库片段：
{{knowledge}}

历史面试记忆（曾经被问过 / 曾经答错的地方）：
{{memory}}`,

    screenshot: `请分析这张面试截图，并给出可直接使用的回答。

输出结构：
## 1. 题意理解
用 1-2 句话说清楚这道题/这段代码在问什么。

## 2. 解题思路
分步骤说明，标注关键技巧与易错点。

## 3. 代码实现
给出完整、可直接运行的 {{lang}} 代码，使用 {{lang}} 的标准库与惯用写法；
不要用伪代码，不要混用其它语言，必要时注明依赖。

## 4. 复杂度
时间 / 空间复杂度，并说明能否优化。

## 5. 边界条件
列出 3-5 个必须考虑的边界与异常输入。

## 6. 口语化回答
一段 60-90 秒可以直接说出来的回答稿。

参考知识库：
{{knowledge}}

相关历史记忆：
{{memory}}`,

    transcript: `面试官刚刚说了下面这段话（语音转写，可能有个别错字，请自行纠正）：

"""
{{transcript}}
"""

请判断意图并给出最佳应对：
- 如果是**技术问题**：给出一句话结论 + 要点 + 必要代码（一律用 {{lang}}，不要用其它语言）+ 60 秒口语稿。
- 如果是**项目/经历追问**：用 STAR 结构组织，优先引用知识库里的真实项目。
- 如果是**行为问题**：给 STAR 骨架并标注需要填充的真实细节。
- 如果是**闲聊/确认信息**：给一句自然的回应即可。
- 如果**没听清或信息不足**：只输出一行"建议追问：……"，不要臆测。

公司：{{company}} ｜ 岗位：{{role}}
相关知识库：{{knowledge}}
相关记忆：{{memory}}`,

    review: `你是一名面试复盘教练。下面是本次面试的原始材料，已按**说话人角色**分区（面试官提问 / 我的回答 / 未区分角色的转写 / 截图分析 / AI 参考回答），请整理成结构化的知识点记忆。

要求：
1. 只输出一个 JSON 数组，不要输出任何解释文字、不要 markdown 代码块围栏。
2. 每个元素对应一个"被问到的问题"，字段如下：
   {
     "question": "面试官的问题（原话或归纳）",
     "knowledgePoints": ["知识点1", "知识点2"],
     "referenceAnswer": "标准答案/参考思路，300 字以内",
     "myAnswer": "候选人当时的回答摘要，150 字以内；材料不足则空字符串",
     "weakPoints": ["薄弱点1", "薄弱点2"],
     "suggestions": "改进建议，150 字以内",
     "tags": ["标签1", "标签2"],
     "mastery": 0-5 的整数（5=完全掌握，0=完全不会）
   }
3. **严格按角色取材**：
   - question 只能来自「面试官提问」；
   - myAnswer 只能来自「我的回答」。
4. **绝对不要拿「AI 参考回答」当候选人的回答**：那是工具生成的参考答案，
   候选人在面试现场未必说过。若「我的回答」里找不到对应的内容，
   myAnswer 就留空字符串，并在 weakPoints 里写明（例如"该问题现场未能作答"）。
5. 「未区分角色的转写」是双方混音、归属不可靠，只能当背景参考，
   不要基于它断定某句话是谁说的，更不要据此给高分。
6. 最多 12 条，按重要性排序。
7. mastery 依据"候选人实际回答质量"判定：答得含糊或不完整给 0-2；
   没有「我的回答」可依据时给 0-1，不要因为 AI 参考回答写得好就给高分。

本次面试：{{company}} / {{role}} / {{round}}

原始材料：
{{material}}`,

    knowledgeInjection: `### 知识库片段（{{category}}）
{{snippets}}`,

    memoryInjection: `### 历史面试记忆（相似问题你曾经的表现）
{{memories}}`
  }
}

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    llm: {
      activeProfileId: 'preset-qwen',
      profiles: [
        {
          id: 'preset-qwen',
          name: '通义千问（OpenAI 兼容）',
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          visionModel: 'qwen-vl-max-latest',
          temperature: 0.3,
          maxTokens: 2048,
          timeoutMs: 60000,
          retries: 2
        },
        {
          id: 'preset-deepseek',
          name: 'DeepSeek',
          baseURL: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          visionModel: 'deepseek-chat',
          temperature: 0.3,
          maxTokens: 2048,
          timeoutMs: 60000,
          retries: 2
        }
      ]
    },
    stt: {
      endpointId: 'beijing',
      model: 'paraformer-realtime-v2',
      mode: 'realtime',
      sampleRate: 16000,
      audioFormat: 'pcm16',
      vadThreshold: 0.35,
      vadSilenceMs: 600,
      languageHints: ['zh', 'en'],
      audioSource: 'both',
      sendMode: 'auto',
      // 双通道：面试官走流式（实时反馈），我自己走整段上传（准确、事后整理）
      channels: defaultChannelConfigs(),
      enableITN: true,
      enablePunctuation: true
    },
    /**
     * ⚠️ 运行形态**只剩一种**：LLM 与语音全部走自建网关，客户端不持有任何上游 Key。
     * 所以这里没有"开关"可言 —— `enabled` 恒为 true（字段本身已标 @deprecated，
     * 保留只为让设置文件格式稳定，将来恢复 BYOK 时不用动 schema）。
     * 详见 `electron/main/cloud.ts` 顶部。
     */
    cloud: {
      enabled: true,
      // 默认本机自部署网关；正式发布时安装包或用户在登录页改掉
      baseURL: DEFAULT_GATEWAY_URL,
      lastMe: null
    },
    hotkeys: {
      toggleWindow: 'Alt+Space',
      toggleClickThrough: 'Alt+C',
      toggleAlwaysOnTop: 'Alt+T',
      toggleRecording: 'Alt+R',
      screenshot: 'Alt+S',
      panicHide: 'Ctrl+Alt+H',
      panicMute: 'Ctrl+Alt+M'
    },
    window: {
      // 背景不透明度（只作用于毛玻璃背景，文字始终清晰；0.15–1）
      opacity: 0.92,
      alwaysOnTop: true,
      topLevel: 'screen-saver',
      clickThroughDefault: false,
      width: 520,
      height: 760,
      stealthOnShare: false,
      showInTaskbar: false
    },
    prompts: defaultPrompts(),
    memory: {
      autoReview: true,
      retrievalTopK: 5,
      reviewIntervals: [1, 2, 4, 7, 15, 30],
      retentionDays: 365,
      enabled: true,
      excludeSensitive: true
    },
    privacy: {
      localOnly: true,
      persistAudio: false,
      persistTranscript: true
    },
    interview: {
      company: '',
      role: '',
      jd: '',
      round: '一面',
      // 代码题默认用 Java 作答（渲染到提示词里的 {{lang}}）
      codeLang: 'Java'
    },
    knowledgeDir: ''
  }
}

/* ------------------------------ 提示词迁移 ------------------------------ */

/**
 * 已保存过设置的安装里，`prompts.*` 是用户自己的副本，改默认值不会生效。
 * 这里做**定点短语替换**而不是整段覆盖：
 * 只替换「确定来自旧默认文案」的那句话，用户自己加的内容一个字都不会动。
 */
const PROMPT_MIGRATIONS: { from: string; to: string }[] = [
  {
    // v1 → v2：代码语言从"优先 {{lang}}，如未指定用 Python"改为强制 {{lang}}
    from: '给出完整、可直接运行的代码（优先 {{lang}}，如未指定用 Python）。',
    to: '给出完整、可直接运行的 {{lang}} 代码，使用 {{lang}} 的标准库与惯用写法；\n不要用伪代码，不要混用其它语言，必要时注明依赖。'
  },
  {
    // v1 → v2：system 里把代码语言固定下来，覆盖转录提问等其它入口
    from: '2. 结构化：先给一句话结论，再给 3-5 个要点，必要时给代码。',
    to: '2. 结构化：先给一句话结论，再给 3-5 个要点，需要写代码时一律使用 {{lang}}。'
  },
  {
    // v1 → v2：转录问答入口显式带上语言
    from: '- 如果是**技术问题**：给出一句话结论 + 要点 + 必要代码 + 60 秒口语稿。',
    to: '- 如果是**技术问题**：给出一句话结论 + 要点 + 必要代码（一律用 {{lang}}，不要用其它语言）+ 60 秒口语稿。'
  },
  {
    // → v3：复盘材料改为按说话人角色分区，提示词需同步说明取材规则。
    // 只替换能确定来自旧默认文案的整段锚点句，用户自写的其余内容一字不动。
    from: '你是一名面试复盘教练。下面是本次面试的原始材料（语音转写 + 截图分析 + AI 回答），请整理成结构化的知识点记忆。',
    to: '你是一名面试复盘教练。下面是本次面试的原始材料，已按**说话人角色**分区（面试官提问 / 我的回答 / 未区分角色的转写 / 截图分析 / AI 参考回答），请整理成结构化的知识点记忆。'
  },
  {
    // → v3：把「AI 参考回答 ≠ 我的回答」这条硬规则补进已有用户的提示词里，
    // 否则模型会把工具生成的答案当成候选人现场说的内容，mastery 会系统性偏高。
    from: '3. 最多 12 条，按重要性排序。\n4. mastery 依据"候选人实际回答质量"判定，答得含糊或不完整就给 0-2。',
    to: '3. **严格按角色取材**：question 只能来自「面试官提问」；myAnswer 只能来自「我的回答」。\n4. **绝对不要拿「AI 参考回答」当候选人的回答**：那是工具生成的参考答案，候选人在面试现场未必说过。若「我的回答」里找不到对应内容，myAnswer 留空并在 weakPoints 里写明。\n5. 「未区分角色的转写」归属不可靠，只能当背景参考，不要基于它断定某句话是谁说的。\n6. 最多 12 条，按重要性排序。\n7. mastery 依据"候选人实际回答质量"判定：答得含糊或不完整给 0-2；没有「我的回答」可依据时给 0-1，不要因为 AI 参考回答写得好就给高分。'
  }
]

function migratePrompts(s: Settings): { s: Settings; changed: boolean } {
  let changed = false
  const prompts: Record<string, string> = { ...s.prompts }
  for (const key of Object.keys(prompts)) {
    const cur = prompts[key]
    if (typeof cur !== 'string') continue
    let next = cur
    for (const { from, to } of PROMPT_MIGRATIONS) {
      if (next.includes(from)) next = next.replace(from, to)
    }
    if (next !== cur) {
      prompts[key] = next
      changed = true
    }
  }
  if (!changed) return { s, changed: false }
  return {
    s: { ...s, prompts: prompts as unknown as Settings['prompts'], version: SETTINGS_VERSION },
    changed: true
  }
}

/**
 * 单体 STT 配置 → 双通道配置迁移。
 *
 * 旧版本只有一个 `audioSource`（mic / system / both）和一对全局 `mode` / `sendMode`。
 * 通道化之后必须把"用户当初那个选择"翻译成"两条链路各自该开还是该关"，
 * 否则老用户升级后两条通道全按默认打开，行为会**静默改变**（比如原本只想录会议声音，
 * 升级后自己的麦克风也开始被转写并落库）。
 *
 * 映射规则（与旧的 audioSource 语义严格对齐）：
 *   - 'system' → 只开 interviewer
 *   - 'mic'    → 只开 candidate
 *   - 'both'   → 两条都开（旧语义就是这么定义的）
 *
 * 同时把旧的全局 `mode` / `sendMode` 继承为两个通道的**初始值**：
 * 老用户显式调过这两个开关，不该被默认值覆盖；
 * 之后再按"这条链路的本质需求"把没被显式改过的部分调成合理默认。
 */
/**
 * 从**用户实际落盘的原始对象**里取出旧的 STT 单源配置，补成双通道。
 *
 * 为什么必须作用在原始对象而不是 deepMerge 之后的结果上：
 * `deepMerge(defaultSettings(), loaded)` 会把新版默认的 `channels` 一并填进去，
 * 于是迁移函数看到 `channels` 已存在就直接跳过 —— **老用户的单源选择被新版默认值悄悄覆盖**，
 * 一个"只录会议声音"的人升级后麦克风也开始被转写。
 * 这是典型的"默认值先注入、迁移后失效"顺序错误，必须在这里拦住。
 */
function rawSTTMigration(loaded: unknown): { loaded: unknown; changed: boolean } {
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) return { loaded, changed: false }
  const raw = loaded as Record<string, unknown>
  const rawStt = raw.stt
  if (!rawStt || typeof rawStt !== 'object' || Array.isArray(rawStt)) return { loaded, changed: false }

  const sttObj = rawStt as Record<string, unknown>
  if (sttObj.channels && typeof sttObj.channels === 'object') return { loaded, changed: false }

  const defaults = defaultChannelConfigs()
  const legacyMode = (sttObj.mode as 'realtime' | 'file') ?? 'realtime'
  const legacySendMode = (sttObj.sendMode as 'auto' | 'edit' | 'manual') ?? 'auto'
  for (const ch of Object.values(defaults)) {
    ch.mode = legacyMode
    ch.sendMode = legacySendMode
  }
  const src = (sttObj.audioSource as 'mic' | 'system' | 'both') ?? 'both'
  defaults.interviewer.enabled = src === 'system' || src === 'both'
  defaults.candidate.enabled = src === 'mic' || src === 'both'

  return { loaded: { ...raw, stt: { ...sttObj, channels: defaults } }, changed: true }
}

/**
 * 把 settings 里存的**绝对路径**从旧数据目录重映射到当前目录。
 *
 * 改名（productName 变化）后，`knowledgeDir` 这类落盘的绝对路径会指向旧目录。
 * 后果不是报错而是**静默退化**：应用发现目录不存在 → 新建 → 再播种一份默认模板，
 * 于是知识库检索全部命中模板，用户自己写的项目经历看起来"凭空消失"。
 */
function remapLegacyPaths(s: Settings): { s: Settings; changed: boolean } {
  const legacy = getLegacyUserDataDirs()
  if (!legacy.length || !s.knowledgeDir) return { s, changed: false }

  const current = app.getPath('userData')
  let next = s.knowledgeDir
  for (const from of legacy) {
    if (next === from || next.startsWith(from + path.sep) || next.startsWith(from + '/')) {
      const rest = next.slice(from.length).replace(/^[\\/]+/, '')
      next = rest ? path.join(current, rest) : current
      break
    }
  }
  if (next === s.knowledgeDir) return { s, changed: false }
  return { s: { ...s, knowledgeDir: next }, changed: true }
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const b = out[k]
    if (b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(b, v)
    } else if (v !== undefined) {
      // 注意：数组走"整体替换"，对 profiles 这类"有稳定 id 的对象数组"是危险的，
      // 见 mergeProfiles() —— 那里按 id 合并以保住密钥字段。
      out[k] = v
    }
  }
  return out as T
}

/* --------------------------- 密钥字段的持久化保护 --------------------------- */

/**
 * 按 id 合并供应商配置数组。
 *
 * 渲染层持有的永远是"脱敏副本"（apiKeyEnc 被剥离，只剩 apiKeyMasked 用于展示），
 * 一旦它把整个 profiles 数组回写，若直接整体替换就会把所有已保存的 Key 抹掉。
 * 因此这里按 id 逐项合并，并强制保住旧的 apiKeyEnc。
 */
function mergeProfiles(base: LLMProfile[], incoming: LLMProfile[]): LLMProfile[] {
  const oldById = new Map(base.map((p) => [p.id, p]))
  return incoming.map((p) => {
    const old = oldById.get(p.id)
    // 新配置：直接采用（此时还没有 Key）
    if (!old) return stripMaskedOnly(p)
    const merged: LLMProfile = { ...old, ...stripMaskedOnly(p) }
    // 密钥只能通过 settings:setSecret 写入；patch 通道不允许覆盖，也不允许用空值/未定义清空
    if (!merged.apiKeyEnc) merged.apiKeyEnc = old.apiKeyEnc
    return merged
  })
}

/** 只剔除纯展示用的脱敏字段，不触碰 apiKeyEnc */
function stripMaskedOnly<T extends { hasKey?: boolean }>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj
  const out = { ...obj }
  delete out.hasKey
  return out
}

/* ------------------------------ 加密存储 ------------------------------ */

let encryptionAvailable: boolean | null = null

function canEncrypt(): boolean {
  if (encryptionAvailable === null) {
    try {
      encryptionAvailable = safeStorage.isEncryptionAvailable()
    } catch (err) {
   console.error('[store] 忽略异常', err)
      encryptionAvailable = false
    }
  }
  return encryptionAvailable
}

/**
 * 加密字符串。不可用时退化：写入明文但打上标记，保证功能不被阻断。
 * 生产环境（Windows/macOS/Linux 桌面端）safeStorage 基本都可用。
 */
export function encryptSecret(plain: string | undefined): string | undefined {
  if (!plain) return undefined
  try {
    if (canEncrypt()) {
      return 'enc:' + safeStorage.encryptString(plain).toString('base64')
    }
  } catch (err) {
   console.error('[store] 忽略异常', err)
    /* fallthrough */
  }
  return 'plain:' + Buffer.from(plain, 'utf8').toString('base64')
}

export function decryptSecret(stored: string | undefined): string {
  if (!stored) return ''
  try {
    if (stored.startsWith('enc:')) {
      if (!canEncrypt()) return ''
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    }
    if (stored.startsWith('plain:')) {
      return Buffer.from(stored.slice(6), 'base64').toString('utf8')
    }
  } catch (err) {
   console.error('[store] 忽略异常', err)
    return ''
  }
  return ''
}

export function mask(secret: string): string {
  if (!secret) return ''
  if (secret.length <= 8) return '•'.repeat(secret.length)
  return secret.slice(0, 4) + '•'.repeat(Math.min(12, secret.length - 8)) + secret.slice(-4)
}

/* -------------------------------- 存储 -------------------------------- */

let cache: Settings | null = null

export function loadSettings(): Settings {
  if (cache) return cache
  const file = getSettingsPath()
  let loaded: unknown = {}
  try {
    if (fs.existsSync(file)) {
      loaded = JSON.parse(fs.readFileSync(file, 'utf8'))
    }
  } catch (err) {
   console.error('[store] 忽略异常', err)
    loaded = {}
  }

  // ⚠️ 必须作用在 deepMerge **之前**的原始对象上：
  // deepMerge 会把新版默认的 channels 填进去，迁移函数就再也看不出"这是老配置"了。
  const sttMigrated = rawSTTMigration(loaded)
  loaded = sttMigrated.loaded
  let dirty = sttMigrated.changed

  let merged = deepMerge(defaultSettings(), loaded)

  const remapped = remapLegacyPaths(merged)
  merged = remapped.s
  dirty = dirty || remapped.changed

  if (!merged.knowledgeDir) merged.knowledgeDir = getDefaultKnowledgeDir()
  if (!merged.interview.codeLang) merged.interview.codeLang = 'Java'

  /* 抹平老配置里的 `cloud.enabled: false`。
     必须显式抹平：deepMerge 会让**文件里的值**覆盖默认值，而那个 false 是
     "云端模式可选"时代的遗留。留着它，将来任何人再读这个字段都会得出与事实
     相反的结论 —— 明明请求全在走网关，配置里却写着"关闭"。 */
  if (!merged.cloud) merged.cloud = { ...defaultSettings().cloud }
  merged.cloud.enabled = true

  const migrated = migratePrompts(merged)
  merged = migrated.s
  dirty = dirty || migrated.changed

  cache = merged

  // 迁移结果立刻落盘：否则每次启动都要重算，且旧路径会一直留在磁盘上
  if (dirty) {
    try {
      writeJsonAtomic(file, merged)
      console.log('[store] 设置已迁移并落盘（数据目录重映射 / 提示词）')
    } catch (err) {
      console.error('[store] 迁移写盘失败', err)
    }
  }
  return cache
}

/**
 * 原子写 JSON：先写同目录下的临时文件，再 rename 覆盖目标。
 *
 * 直接用 writeFileSync 覆盖的风险：写到一半进程崩溃 / 断电，settings.json 会变成
 * 半截 JSON —— 用户丢失的不只是配置，**所有加密后的 API Key 也一起没了**。
 * rename 在同一分区内是原子替换，读到的要么是旧完整文件，要么是新完整文件。
 */
export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {
    console.error('[store] 写入失败', file, err)
    // 尽力清理临时文件，避免残留占空间
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      /* noop */
    }
    throw err
  }
}

export function saveSettings(next: Settings): Settings {
  cache = next
  try {
    writeJsonAtomic(getSettingsPath(), next)
  } catch (err) {
    console.error('[store] 保存设置失败', err)
  }
  return cache
}

export function patchSettings(patch: Partial<Settings>): Settings {
  const cur = loadSettings()
  const merged = deepMerge(cur, patch) as Settings

  // profiles 是数组，deepMerge 会整体替换 → 必须按 id 重新合并以保住各自的 Key
  if (patch.llm?.profiles?.length) {
    merged.llm.profiles = mergeProfiles(cur.llm.profiles, patch.llm.profiles)
  }
  // STT 的 Key 同理：patch 通道不允许清空
  if (merged.stt && !merged.stt.apiKeyEnc && cur.stt.apiKeyEnc) {
    merged.stt.apiKeyEnc = cur.stt.apiKeyEnc
  }
  // 云端 token 同理：登录/登出只走 cloud:* 通道，patch 不允许清空它
  if (merged.cloud) {
    if (!merged.cloud.tokenEnc && cur.cloud?.tokenEnc) merged.cloud.tokenEnc = cur.cloud.tokenEnc
    // 这里也要抹平：patch 走的是 saveSettings（直接覆盖缓存），绕过 loadSettings 的归一化
    merged.cloud.enabled = true
    // 脱敏展示字段不落盘
    delete (merged.cloud as { hasToken?: boolean }).hasToken
  }
  // 脱敏展示字段不落盘
  delete (merged.stt as { apiKeyMasked?: string }).apiKeyMasked

  return saveSettings(merged)
}

export function getSettings(): Settings {
  return loadSettings()
}

/**
 * 知识库目录的安全校验。
 *
 * knowledgeDir 是一个能被渲染层通过 `settings:patch` 直接改写的字段，而主进程随后会
 * 对它 `mkdirSync` **并写入 6 个示例 Markdown**。没有校验的话，把目录指向
 * `C:\Windows` 或系统盘根目录，就等于拿到了一个任意路径的建目录 + 写文件入口。
 */
export function assertSafeKnowledgeDir(dir: unknown): asserts dir is string {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('知识库目录不能为空')
  const raw = dir.trim()
  if (!path.isAbsolute(raw)) throw new Error('知识库目录必须是绝对路径')

  const norm = path.resolve(path.normalize(raw))
  // 不允许把目录设在某个盘/分区的根下
  if (norm === path.parse(norm).root) throw new Error('不能把知识库目录设为磁盘根目录')

  let forbidden: string[]
  if (process.platform === 'win32') {
    forbidden = [
      process.env.SystemRoot || process.env.windir || '',
      process.env.ProgramFiles || '',
      process.env['ProgramFiles(x86)'] || ''
    ].filter(Boolean)
  } else {
    forbidden = ['/System', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/Library']
  }
  if (forbidden.some((root) => isSameOrSub(norm, path.resolve(root)))) {
    throw new Error('知识库目录不能设在系统目录或其子目录')
  }
  return
}

function isSameOrSub(target: string, root: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 仅测试用：丢弃内存缓存，强制从磁盘重新读取 */
export function resetCacheForTest(): void {
  cache = null
}
