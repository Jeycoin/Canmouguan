# 「参谋官」云端网关

把上游 API 密钥**关在这台机器里**，对外只发账号和额度。

客户端（买家电脑上的 `参谋官.exe`）不再持有任何 DashScope / 智谱的 Key，
所有大模型与语音请求都经这里转发并计量。

---

## 为什么需要它（而不是直接用某个 BaaS）

最初考虑过用托管后端（云数据库 + 内置登录 + 免密钥模型调用），但两条硬约束把它排除了：

1. **登录绑定在"已注册的 HTTPS 发布域名"上**。桌面客户端的页面来源是 `file://`
   （打包后是 `file:///…/app.asar/index.html`），既不是 HTTPS 域名也没有可注册的 Origin，
   拿不到会话。这是设计边界，不是配置问题。
2. **实时转写是 WebSocket 长连接**。托管后端的数据库/存储是请求-响应模型，
   没有"把一个长连接双向透传到另一个 WebSocket 服务"的能力，
   而实时转写恰恰是面试官提问那条链路的核心。

所以这里自建一个进程。代价是要有台机器跑它；收益是完全可控 ——
尤其是计量的准确性，它决定了这个商业模式能不能赚钱。

---

## 快速开始

```bash
cd server
cp .env.example .env
# 编辑 .env，至少填两个上游 Key：
#   CMG_DASHSCOPE_API_KEY   ← 阿里云百炼（语音识别）
#   CMG_LLM_API_KEY         ← 智谱 open.bigmodel.cn（大模型）
npm install          # 只装 ws 一个依赖
npm start
```

启动后：

```bash
# 生成 10 个「专业版 1 个月」兑换码
node bin/issue.js issue month 10 --note 首批内测

# 看全局用量与成本粗估
node bin/issue.js stats

# 看某个用户的用量明细
node bin/issue.js usage <账号>
```

**端到端自测**（不需要真实上游 Key，也不真的发短信，会起一个假上游 + 一个假短信服务商）：

```bash
npm test              # = 短信配置闸门 + 端到端自测，共 91 项断言
npm run selftest      # 只跑端到端那 83 项
```

自测会起**两个**网关实例：一个走 `console` 短信通道、一个走 `webhook`，
共用同一个数据目录（顺带验证多进程共用同一个库与同一个签名密钥）。

---

## ⚠️ 成本与定价：改额度之前先读这段

网关把「用户自己买 Key、自己付费」变成了「**你承担持续成本**」。
这是整个改造里唯一不可逆的变化，也是定价的地基。

实测单价（阿里云百炼官方价，2026-09 查证）：

| 用途 | 模型 | 单价 | 折合 |
| --- | --- | --- | --- |
| 面试官提问（实时流式） | `paraformer-realtime-v2` | 0.00024 元/秒 | **¥0.864/小时** |
| 我的回答（停止后整段上传） | `paraformer-v2` | 0.00008 元/秒 | **¥0.288/小时** |

**双通道是同时跑的，所以一场 1 小时面试 ≈ ¥1.15 的语音硬成本**（LLM 另计，很小）。

> 官方"每月 10 小时免费额度"是**按百炼账号**算的，不是按终端用户。
> 所有用户共用你的账号 = 全平台共享那 10 小时，**对多用户规模等于没有**。
> 免费体验因此是你自己掏钱，必须按用户设硬上限。

默认额度（`.env` 可改）：

| 套餐 | 周期 | 语音 | 提问 | 对应成本 |
| --- | --- | --- | --- | --- |
| 免费体验 | 一次性，永不清零 | 30 分钟 | 50 次 | 约 ¥0.3 |
| 专业版 | 每月重置 | 20 小时 | 2000 次 | 约 ¥11.5 |

定价校验：**专业版每 1 小时语音额度 ≈ ¥0.58 成本**。
所以定价 ¥29/月 时要确保用户平均用不到 ~25 小时的量，否则毛利被吃光
（还没算服务器、带宽、支付手续费）。**建议 ¥49–99/月，或把月额度压到 15 小时。**

另外注意：求职者的使用是**密集短期**的（找工作那几个月猛用），
集中薅的风险比订阅制高，免费额度和并发限制都要收紧一点。

### 售卖形态：兑换码，不是订阅

当前形态是**买断式兑换码**（`REDEEM_PLANS`）：用户买一个码，换来一段有效期（7 / 31 / 93 / 366 天），
到期**不会自动扣款**，想继续用得再买一个。所以：

- 「月」指的是**有效期长度**，不是扣费周期。额度在有效期内按月重置（`quota.js` 的 `period`），
  但**不会产生任何自动扣费**。
- **续费 = 再兑一个码**，且是**叠加**在现有到期时间上（提前续费不会吃亏）。
- 客户端与落地页的文案必须一致地说"一次付费、不自动续费" ——
  暗示会自动续费会导致用户到期被停而投诉（这是最容易产生客诉的一句文案）。
- 没有自动续费也意味着**续费率天然低于订阅制**：想提高复购，靠的是"到期前提醒"而不是"自动扣款"。

---

## 接口

所有需要登录的接口都带 `Authorization: Bearer <token>`。
客户端只改两处：`baseURL` 指向本服务、`apiKey` 换成这个 token。

### 账号

账号既可以是自定义用户名/邮箱，也可以直接用手机号（不传 `account` 时手机号即账号）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 存活、上游配置、**短信通道状态**、**发卡回调是否开启**（无需鉴权） |
| `POST` | `/api/auth/sms/send` | `{phone, purpose}` → 下发验证码，`purpose` 为 `register` 或 `login` |
| `POST` | `/api/auth/register` | `{account, password, code?}` 或 `{phone, smsCode, password, account?}` → `{token, me}` |
| `POST` | `/api/auth/login` | `{account, password}` / `{phone, password}` / `{phone, smsCode}` → `{token, me}` |
| `GET` | `/api/me` | 当前套餐与剩余额度 |
| `POST` | `/api/redeem` | `{code}` → 开通/续期 |
| `GET` | `/api/plans` | 套餐、价格、购买方式（**无需鉴权**，见下） |
| `GET` | `/api/usage` | 用量 + 最近事件 |

⚠️ 注册请求里的 `code` 是**邀请码/兑换码**，短信验证码是 **`smsCode`**。两者同时出现，别混。

`/api/plans` **刻意不要求登录**：用户是先买码、再注册的，要求先登录才能看到价格等于把最大的那部分人挡在门外。
价格与购买链接由这里下发，客户端不写死 —— 改价、换渠道、换客服微信都是配置改动，不必重新打包客户端。
价格与 `days` 都取自 `REDEEM_PLANS`，**不给第二个真相来源**（两处各写一份迟早出现"标价 1 个月、实际发 7 天"）。

认证相关失败用 `reason` 分支即可（不要匹配文案）：

| reason | 含义 |
| --- | --- |
| `invalid_phone` | 手机号不是 11 位大陆号段 |
| `phone_taken` | 手机号已注册（发码与注册都会返回） |
| `phone_not_registered` | 用验证码登录，但该号还没注册 |
| `sms_not_configured` | 短信通道未就绪（HTTP 503，**不是**服务器 bug，去配 `CMG_SMS_*`） |
| `sms_failed` | 短信服务返回非 2xx 或不可达（HTTP 502，`message` 里带上游状态码） |
| `too_soon` | 重发冷却中，响应里带 `retryAfterMs` |
| `rate_limited` | 单号 / 单 IP 小时配额用尽 |
| `code_missing` / `code_expired` / `code_wrong` / `code_locked` / `code_used` | 验证码不存在 / 过期 / 不对 / 错太多次作废 / 已用过 |

短信层的三条硬规则（都有测试锁着，改之前先看 `lib/sms.js` 顶部注释）：

1. **先发、后落库**。发送失败绝不留下可用验证码，因此也不会占用重发冷却 —— 通道恢复后能立刻重试。
2. **验证码只存 HMAC**（用 `gateway.secret` 做 pepper）。6 位数字的裸哈希等于明文，必须加 pepper 才有意义。
3. **`purpose=login` 不预检号码是否注册**，只有号主本人拿得到码，所以"未注册"提示不会变成账号枚举通道。

### 发卡平台回调（自动发码）

收银台放在发卡平台，网关只做一件事：**收到付款通知 → 现场签发兑换码 → 返回给平台展示**。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/hook/card` | 鉴权用**平台 token**（不是用户 token）：`Authorization: Bearer <CMG_PAYHOOK_TOKEN>`，平台只能填 URL 时用 `?token=` |

请求体字段名各家平台不一致，网关按优先级取第一个非空值：

| 语义 | 接受的字段名 |
| --- | --- |
| 订单号（必填） | `order_id` / `orderId` / `trade_no` / `tradeNo` / `out_trade_no` / `outTradeNo` |
| 商品 ID（必填） | `sku` / `goods_id` / `goodsId` / `product_id` / `productId` |
| 数量（可选） | `count` / `quantity` / `num` |
| 金额（可选） | `amount` / `price` / `total` |
| 来源标识（可选） | `platform` / `source` |

响应：`{ok, code, codes, content, kind, plan, days, orderId, replayed}`。
`content` 是多码拼接的纯文本，绝大多数发卡平台会把它当卡密正文直接展示。

**四条必须守住的语义**（都有测试锁着，改之前先看 `lib/payhook.js` 顶部注释）：

1. **默认关闭**。`CMG_PAYHOOK_TOKEN` 为空时返回 503 —— 这个端点能在**没有任何账号**的前提下凭空发会员，
   绝不能"没配就当开放"。配了强随机 token 再开，并建议在 Nginx 上限制调用来源 IP。
2. **幂等**。`(platform, order_id)` 是唯一索引；重复回调**原样返回上次那批码**（`replayed: true`），
   绝不重新签发。平台没收到 200 会重试，没有这条就会"一次付款发两次码"。
3. **不认识的商品报错，绝不落回默认套餐**。落回默认会把"卖 7 天试用"的订单发成"专业版 1 年"，
   而且没有任何地方会提示 —— 只会在对账时发现收入对不上。
   平台商品 ID 与套餐类型对不上时，用 `CMG_PAYHOOK_PRODUCTS=sku-abc123=month,...` 配映射。
4. **不校验金额**。网关不参与收款，回调里的金额只记下来供对账。拿它当判断依据会引入
   "平台金额字段改了就发不出码"的脆弱性。

> 为什么是"回调现发"而不是"预先生成一批码填进平台库存"：
> 后者的码在别人库里，平台被拖库 = 你的码全泄露，而且你无法知道"卖出去了但没人来兑换"的码去哪了。
> 回调模式下码从生成到交付不超过一秒，库里不存在"一大批发出去还没被用的码"。

### 上游代理（OpenAI / DashScope 兼容）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | LLM，`stream:true` 时 SSE 透传 |
| `POST` | `/v1/audio/transcriptions` | 文件转写（multipart） |
| `WS` | `/v1/asr/realtime` | 实时转写，协议与百炼同构 |

**失败响应用 `reason` 分支，不要匹配文案**：

| reason | 含义 | 客户端应做什么 |
| --- | --- | --- |
| `unauthenticated` | token 失效 | 回到登录页 |
| `llm_quota_exhausted` / `asr_quota_exhausted` | 额度用完 | 提示兑换/续费 |
| `too_many_realtime` | 并发实时通道超限 | 提示先停止当前录音 |
| `upstream_error` | 上游报错（含 401/429） | 展示 `detail` |
| `model_not_allowed` | 模型不在白名单 | 用默认模型重试 |

---

## 部署到服务器

1. **改监听地址**：`.env` 里 `CMG_HOST=0.0.0.0`（本机调试保持 `127.0.0.1`）。
2. **套 Nginx 做 TLS**（必须，否则 token 明文过网）。
   ⚠️ 两条关键配置，漏了会把流式废掉：
   ```nginx
   location /v1/chat/completions {
     proxy_pass http://127.0.0.1:8787;
     proxy_buffering off;          # 不关的话 SSE 会被攒批，首字延迟暴涨
     proxy_cache off;
     proxy_read_timeout 300s;
   }
   location /v1/asr/realtime {
     proxy_pass http://127.0.0.1:8787;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;      # 不配这两行 WebSocket 直接握手失败
     proxy_set_header Connection "upgrade";
     proxy_read_timeout 3600s;                    # 长连接，别用默认 60s
   }
   ```
3. **systemd 常驻**（`Restart=always`），并设置 `CMG_GATEWAY_SECRET`
   —— 不设的话每次重启会重新生成，**所有用户被踢下线**。
4. **备份**：`server/data/gateway.db` 直接 `cp` 就是完整备份（WAL 模式下连 `-wal` 一起拷）。

### 内测期的两个建议

- `CMG_ALLOW_SELF_REGISTER=0` + 只发兑换码 —— 避免陌生人注册占额度。
- 打开 `CMG_REGISTER_INVITE_CODE=<一个内测码>` 做第二道门。

---

## 安全须知（这几条是底线）

- **上游 Key 只存在于服务端**。任何情况下都不要下发到客户端 ——
  一旦下发，配额就失效了，因为用户可以绕过你的服务直接打上游。
- **配额判定只在服务端**（`lib/quota.js`）。客户端展示的"剩余额度"是缓存，可伪造；
  放行与否永远以服务端为准。
- **模型走白名单**。透传用户传的模型名 = 把你账号里所有模型开放出去，
  包括贵十几倍的。`relay-llm.js` / `relay-asr.js` 都会改写/拒绝非白名单模型。
- **`.env` 与 `data/` 不入库**（已写进 `.gitignore`）。`data/gateway.secret` 泄露
  等于任何人都能伪造 token。
- **不要 `console.log` 打印 token / Key / 手机号**。事件表（`events`）里也不要写 ——
  写入前一律过 `maskIdentity()`（`138****0000` / `a***@example.com`）。
- **登录验证码绝不能进日志**。因此 `console` 短信通道在生产环境（`NODE_ENV=production`）
  会被**自动拒绝**，必须配 `webhook`；只有受控环境才用 `CMG_SMS_ALLOW_CONSOLE=1` 显式放行。

## 已知边界（第一步刻意不做的）

- 没有支付，靠兑换码发会员；收银台在**发卡平台**，网关只接收款回调现签码。
- 没有设备绑定：一个账号可以在多台机器登录（靠并发限制部分缓解）。
- **没有找回密码**。手机号只用于"注册 + 登录"，刻意不做短信重置密码 ——
  运营商回收号段后新机主可以借此接管老账号，接支付前必须先把这条设计清楚。
- 短信通道目前只有 `console`（本机自测）与 `webhook`（转给你自己的适配器）两种，
  没有内置阿里云/腾讯云 SDK —— 换服务商不该改网关代码，加适配器更合适。
- 限流是进程内的，单机够用；多实例部署时要换成 Redis 之类的集中限流。

---

## 目录结构

```
server/
  index.js              HTTP 路由 + WS 升级分发 + 进程生命周期
  lib/
    env.js              配置（含套餐额度、短信策略、商店信息与发卡回调，零依赖 .env 加载）
    db.js               SQLite 表结构与查询封装（含 users.phone 迁移、发卡订单台账）
    auth.js             scrypt 口令哈希 + HMAC 自签 token
    sms.js             短信通道接缝 + 验证码签发/校验策略
    payhook.js          发卡平台回调 → 现场签发兑换码（幂等 + 鉴权 + SKU 映射）
    quota.js            ⭐ 配额判定与记账（所有放行判断都在这）
    redeem.js           兑换码生成/归一化/原子核销
    http.js             响应封装、请求体上限、限流
    relay-llm.js        LLM SSE 透传（含模型白名单改写）
    relay-asr.js        文件转写代理 + 实时 WS 双向透传与计量
  bin/issue.js          运营命令行
  test/sms-config.js    短信配置闸门（8 项断言，多环境变量组合）
  test/selftest.js      端到端自测（假上游 + 假短信服务商，99 项断言）
  data/                 运行时数据（gitignore）
```
