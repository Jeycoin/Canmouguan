# 参谋官（Cluely 风格）

半透明悬浮的面试辅助工具。Electron 44 + React 19 + TypeScript，客户端登录后经自建网关转发语音与大模型请求。

> 项目代号 `canmouguan`　|　官网域名：canmouguan.cloud

> ⚠️ 合规提醒：本工具定位为学习、模拟面试与个人辅助。使用前请自行确认是否符合面试平台规则与公司规定。工具默认**不开启**屏幕共享隐蔽。

## 快速开始

```bash
npm install          # 已配置 Electron 国内镜像环境变量时可自动下载二进制
npm run dev          # 开发模式（tsc watch + vite + electron）
npm run build        # 编译主进程 + 打包渲染层
npm start            # 运行已构建产物（不开 vite）
npm run dist         # 打 Windows 安装包（nsis）
```

> 开发模式下 `npm run dev` 会依次启动：主进程 TS 编译 watch → Vite(5173) → Electron。
> 窗口默认出现在屏幕左上；如果被挡住或跑到别的显示器，按 `Alt+Space` 显隐，或点托盘图标「移到鼠标所在屏」。

### 启动没反应 / 窗口不出来？

**先做这一步**：`npm run dev` 会通过 `scripts/start-electron.js` 启动，日志里应该出现

```
[start-electron] 启动 electron.exe .
```

如果没看到这行，说明 Electron 没被拉起来。最常见的原因是环境变量 `ELECTRON_RUN_AS_NODE=1`——
VS Code、WorkBuddy 这类基于 Electron 的 IDE，其**内置终端**会注入该变量，它让 `electron.exe`
退化成纯 Node 进程，主进程 `require('electron')` 拿到的是文件路径字符串而非 API，于是第一行就崩。

`npm run dev` / `npm start` 已内置清理逻辑，无需手动处理。若你自己直接跑 `electron .`，请先：

```bash
# bash / Git Bash
unset ELECTRON_RUN_AS_NODE

# PowerShell
$env:ELECTRON_RUN_AS_NODE = ""
```

真被这个变量坑到时，主进程会直接打印一行醒目的中文报错并退出，不会默默失败。

### 远程桌面 / 无 GPU 环境崩溃？

如果日志出现 `GPU process isn't usable. Goodbye.`，说明当前会话 GPU 不可用
（RDP 远程桌面、显卡驱动异常等都会触发）。启动脚本会**自动检测这种崩溃并切换软件渲染重试**，无需干预。
也可以手动指定：

```bash
npm run dev:sw     # 软件渲染（SwiftShader），适合远程桌面 / 无 GPU 环境
```

软件渲染下毛玻璃与全部功能照常可用，仅帧率略低。

## 首次配置

1. **登录**。应用启动即停在登录页，三件事都在那一屏完成：
   - 填网关地址（如 `https://canmouguan.cloud`，**不要**带 `/v1`），点「检测」确认能连通；
     自建服务器就填自己的域名，不自建则用默认的本机地址。
   - **注册**：账号密码，或手机号（收短信验证码）。有兑换码就一并填入，注册后直接开通会员。
   - **登录**：账号密码 / 手机号 + 密码 / 手机号 + 验证码，三种都支持。
2. **设置 → 面试信息** 填公司 / 岗位 / JD / 轮次，会填充到提示词变量。
3. **代码语言**（同页）默认 `Java`。截图分析、转录问答里需要写代码时统一用这个语言，
   不要伪代码、不混用其它语言；下拉可选常见语言，也可手填其它（留空按 Java 处理）。

> 语音与大模型的密钥都在**网关服务器**上，客户端没有填 Key 的地方，也不需要选供应商 ——
> 能用的模型由服务端 `/api/models` 下发，与本机配置无关。
> 登录凭据走 `safeStorage` 加密落盘，且**永远不下发到渲染层**，渲染层的任何脚本都拿不到它；
> 凭据失效（过期 / 被停用）时会被自动清除并回到登录页。

### 怎么买会员

客户端**只认兑换码，不接支付** —— 所以「设置 → 账号」里显示的购买方式（购买链接 / 客服微信）
来自服务端下发，付款拿到码后在那里兑换即可；登录页也会给出同一个入口（想买的人通常还没账号）。

兑换码语义：一个码换一段有效期，**一次付费、不自动续费**；
已是会员时再兑会在原到期时间上**顺延**，提前续费不会吃亏。

## 云端网关

`server/` 是一个**独立部署的 Node 服务**（不进客户端打包），负责保管上游密钥、计量用量、按账号发额度。
客户端只有这一种运行形态 —— 所有语音与提问都经它转发。

- **发会员**：发卡平台回调自动发码（`POST /api/hook/card`，幂等 + 鉴权），或手工 `bin/issue.js`
- **价格与购买方式**：`GET /api/plans` 由服务端下发，客户端不写死（改价不必让老用户重下客户端）

搭建、成本与定价、完整接口（含发卡回调）、nginx / systemd 部署见 [`server/README.md`](server/README.md)。

## 全局快捷键（可在设置中改）

| 动作 | 默认 |
| --- | --- |
| 显示 / 隐藏窗口 | `Alt+Space` |
| 鼠标穿透 / 可交互 | `Alt+C` |
| 切换始终置顶 | `Alt+T` |
| 开始 / 停止录音 | `Alt+R` |
| 一键截图分析 | `Alt+S` |
| 紧急隐藏 | `Ctrl+Alt+H` |
| 紧急静音 | `Ctrl+Alt+M` |

**鼠标穿透**开启后，点击会直接落到下层页面（本工具不可交互）；再次按 `Alt+C` 恢复。

## 功能说明

- **语音转写**：麦克风 + 系统声音双通道（系统声音走 loopback，可捕获会议软件里面试官的声音）。实时模式边录边显示；离线模式停止后上传转写。空文本不发送，支持 自动 / 编辑后 / 手动 三种发送策略。
- **截图分析**：`Alt+S` 或相机按钮，自动裁剪到最长边 1568px 后交给视觉模型，输出 题意理解 / 思路 / 代码 / 复杂度 / 边界 / 口语稿。代码一律用「设置 → 面试信息 → 代码语言」指定的语言（默认 Java）作答。
- **知识库**：`userData/knowledge/` 下的 Markdown（首次启动自动生成 6 篇模板：自我介绍 / 项目经历 / 技术八股 / 算法题 / 行为面试 / 反问）。改动自动热加载，关键词检索（二元切分 + BM25 简化打分），检索结果按变量注入提示词；后续可无缝替换为向量 RAG（接口 `searchKnowledge` 不变）。
- **面试复盘**：点「开始面试」后自动关联转写 / 截图 / AI 回答；「结束面试」自动触发复盘 LLM，输出结构化知识点存入记忆库。
- **记忆库**：支持检索 / 标签 / 掌握程度 / 编辑合并 / 导入导出（JSON、Markdown） / 一键清除；新提问会自动检索相似记忆注入 `{{memory}}`。
- **复习模式**：基于间隔重复（默认 1/2/4/7/15/30 天），标记 已掌握 / 模糊 / 不会 决定下一档间隔。

## 提示词变量

系统 / 截图 / 转录 / 复盘提示词均可在设置中编辑，支持：

`{{company}}` `{{role}}` `{{jd}}` `{{round}}` `{{transcript}}` `{{knowledge}}` `{{memory}}` `{{lang}}` `{{material}}`

修改立即生效；「渲染预览」可查看变量填充结果。

`{{lang}}` 来自「面试信息 → 代码语言」，默认 `Java`。

> **老版本升级提示**：提示词一旦保存过就是用户自己的副本，改默认值不会自动生效。
> 因此对旧安装做了**定点短语迁移**（见 `store.ts` 的 `PROMPT_MIGRATIONS`）：
> 只替换能确定来自旧默认文案的那几句，把写死的 Python 换成 `{{lang}}`，
> 你自己加的内容一个字都不会动。迁移结果会立刻落盘。

## 目录结构

```
electron/
  main/        主进程：window 窗口与穿透 / shortcuts 全局快捷键 / capture 截图
               stt 百炼转写（WebSocket 实时 + HTTP 离线 + VAD）/ llm OpenAI 兼容流式
               knowledge MD 知识库 / memory 记忆库 / prompt 变量渲染 / ipc 全部 IPC
  preload/     contextBridge 桥接（渲染层无 Node 权限）
  shared/      前后端共享类型与预设
src/           React 渲染层（对话 / 知识库 / 记忆 / 复习 / 设置 五个面板）
```

数据位置：`%APPDATA%/canmouguan/`（settings.json 加密配置、memory.json 记忆、knowledge/ 知识库）。

> 目录名由 `electron/main/appdir.ts` **钉死**为 ASCII 常量 `canmouguan`，与产品名解耦。
> 如果直接依赖 Electron 默认的 `userData = %APPDATA%/<productName>`，那么每次改产品名
> 都会让用户的配置和加密 Key"凭空消失"（其实是被丢在旧目录里没人读）。
> 该模块在启动时还会把历史目录（`Interview Copilot`、`interview-copilot`）整体搬迁过来。

## 回归测试

```bash
npm run test:secret   # API Key 持久化回归测试（30 项断言，走真实 IPC）
npm run smoke         # UI 冒烟：遍历 5 个面板检查零报错，并截图 smoke*.png
npm test              # 单元测试（Vitest）：检索 / 记忆导入导出 / 会话持久化 / 路径安全 / 云端落点 / Markdown 净化
npm run verify:cloud  # 客户端↔网关真实链路（25 项断言，需要真起网关 + 假上游）
npm run verify:quit   # 主进程退出收尾（不改生命周期可跳过）
```

`verify:cloud` 起**真的网关 + 真协议形状的假上游**，走完 HTTP / WebSocket / SSE 三条线：
注册带码开通会员、实时转写双向透传与按字节计量、SSE 逐包不被缓冲、模型白名单改写、
无效 token 的拒绝文案、以及「patch 通道无法清空 token」。只跑单元测试和网关自测
**覆盖不到这条缝** —— 路径或鉴权头写错时，两边都全绿而客户端就是连不上。

`test:secret` 覆盖：双配置各自独立保存 Key、切换当前配置不丢 Key、改温度/模型/STT 参数不影响 Key、
脱敏副本回写不覆盖 Key、重启后仍在、主动清除才生效、`settings:get` 不泄漏密文。

## 性能诊断

回答慢时先分清「本地链路慢」还是「模型/网络慢」，不要凭感觉换代码：

```bash
npm run bench                                  # 只跑本地 mock，不联网不花钱
npm run bench -- --key=<KEY> --real            # 顺带用真实 Key 跑对照（Key 只进加密配置）
npm run bench -- --key=<KEY> --model=glm-4-flash --vision=glm-4v-flash --real
node scripts/bench-api.js --key=<KEY> --model=<模型> [--image=xx.png]   # 纯 Node 直连，绕开 Electron
```

`bench` 会分段打印：截图链路的 `getSources / crop+resize / toDataURL`、dataUrl 体积、
以及「纯文本 / 带图 / 带压缩图」三种请求的首字延迟（TTFT）与吞吐。
`bench-api.js` 用来排除 Electron 这个变量——直连也慢就说明锅在供应商侧。

实测参考（本机、智谱 BigModel）：

| 环节 | 耗时 |
| --- | --- |
| 截图链路（优化后） | ~660 ms（`getSources` 418ms + resize 17ms + base64 37ms） |
| 本地 mock 供应商 TTFT | ~50-76 ms（即本地链路本身几乎无开销） |
| glm-4-flash 纯文本 | TTFT 405 ms ／ 总 2.6 s |
| glm-4v-flash 带图 | TTFT 735 ms ／ 总 4.8 s |
| glm-5.3-flash 纯文本 | TTFT 7-14 s（思考链 ~800-2000 字） |
| glm-5.3-flash 带图 | 12-37 s，且常因思考耗尽 max_tokens 而**没有正文** |

> ⚠️ `glm-5.3-flash` 属于「强制思考」模型，官方不支持关闭 thinking（只接受 low/high/max）。
> 它做面试实时辅助会表现为长时间空白、甚至一个字都不出。
> 设置里的「智谱 · 极速」预设（`glm-4-flash` + `glm-4v-flash`）是为此场景准备的。
> 「测试连接」按钮现在会直接报出首字延迟与是否检测到思考链。

## 隐私

- 全部数据默认仅存本地，无云端同步。
- 音频默认不落盘，转写在内存中完成后即丢弃；进行中的面试会话会实时写入
  `session-current.json`，异常退出（崩溃 / 强杀）后重启可恢复并补复盘。
- 设置 → 隐私 可一键清除全部历史（记忆库 + 全部面试会话及其转写全文 + 缓存截图，
  知识库 Markdown 不受影响）。复盘可自动排除敏感话题（薪资 / 加班等）。
