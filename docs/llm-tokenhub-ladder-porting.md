# LLM 阶梯模型链 · 移植指南

- **来源**：QQBotForFun 于 2026-09-18 落地并上线的一套机制
- **目的**：让 SilentWereWolf 用上 TokenHub 的**免费额度池**，并在额度耗尽/限流/故障时
  **自动换档**，而不是直接失败或反复打同一个死档
- **本文只讲「做什么 + 为什么」**，不复制代码 —— 两边技术栈不同
  （QQBotForFun = Python + openai SDK；本项目 = TS + 原生 fetch），移植的是设计

---

## 1. 移植前的现状

| 项 | SilentWereWolf |
|---|---|
| 接入层 | `server/game/ai/AIApiClient.ts`，单函数 `callLLM()` |
| 配置 | 环境变量 `ZHIPU_API_KEY` / `ZHIPU_MODEL` / `ZHIPU_BASE_URL` |
| 模型数 | **1 个**（默认 `glm-4-flash`） |
| 失败处理 | 返回 `{ success: false, error }`，调用方**用同一个模型**重试一次 |
| 冷却 | 无 |
| 调用点 | `AIPlayerController.ts` 4 处（夜间行动 / 标记发言 / 投票 / 技能触发）+ `generateAIName` + `testAIConnection` |

**核心问题**：一个模型挂了就是全局挂。而 TokenHub 提供「单 Key 多模型」，
33+ 个模型各有独立免费额度，**额度耗尽后换下一个就是纯赚**。

---

## 2. 核心设计（4 条，照做即可）

### 2.1 单模型 → 有序模型链

把 `ZHIPU_MODEL` 一个值，换成**一串**模型名，按序尝试：

```
链头（首选档）→ 第 2 档 → 第 3 档 → ... → 链尾兜底
```

**每一档是一个独立的额度池**，前一个用完就降下一个。链尾必须是对家的免费池
（如智谱 `glm-4-flash-250414`）—— 保证「链路全挂时也不比改造前差」。

**本项目不需要 QQBotForFun 那种 per-scene 链**：狼人杀 AI 的 4 类动作对模型能力要求相近，
**一条全局共享链就够了**，比源头更简单。

**排序依据**：TokenHub 的免费额度**不刷新、用完即废**，所以**快过期的档必须先用**。
`GET /v1/models` 会给出每个档的 `status`，其中 **`pre-offline` = 已公告下线但仍可调用**，
正是最该优先烧的那批。

### 2.2 错误分两类：能重试的 / 该降档的

**不要把所有失败都当"重试"**，这是最关键的一条：

| 类型 | 判据 | 处理 |
|---|---|---|
| 限流 | HTTP 429 | **就地退避重试**（同档重试有意义） |
| 抖动 | HTTP 5xx、超时、`401006` | **就地退避重试** |
| 额度耗尽 | HTTP 402 | **打冷却 + 降下一档**（重试也没用） |
| 鉴权失败 | HTTP 401 / 403 | 打冷却 + 降档 |
| 模型下线 | HTTP 404 | 打冷却 + 降档 |
| 参数错误 | HTTP 400 | 通常是参数没迁就模型，**别白白降档**（见 §4-5） |

### 2.3 额度耗尽的冷却必须"递增"

TokenHub 额度**不刷新**（不是每天回满）。如果照抄常见的「限流冷却 6 小时」：

> 每 6 小时就会白白打一次**已经永久耗尽**的档，浪费延迟也浪费一次尝试。

**正确做法**：额度耗尽的冷却**指数递增 + 封顶**：

```
6h → 12h → 24h（封顶）
```

封顶是为了留一条自愈路径（万一是临时 402 或额度被后台补发）。成功一次即清零计数。

### 2.4 诊断默认零消耗

**探活就是烧额度**。所以：

- 诊断入口**只读内存里的冷却状态**，不发起任何真实调用；
- 唯一"真打一次"的是连通性测试（本项目已有 `testAIConnection`），保留即可。

---

## 3. 落地步骤（TS 版）

### 3.1 配置

新增环境变量（**不要写进代码仓库**，`.env` 要 gitignore）：

```ini
# 腾讯云 TokenHub（广州站）—— 单 Key 多模型，只消费免费额度
TOKENHUB_API_KEY=

# 可选的链序覆盖（逗号分隔，逗号后不要留空格）
# 留空则用代码里的默认链
LLM_MODEL_CHAIN=tokenhub:qwen3.5-plus,tokenhub:qwen3.5-flash,tokenhub:glm-5.1,zhipu:glm-4-flash-250414
```

`ZHIPU_*` 三个变量**保留不动** —— 它们变成链尾兜底。

> ⚠️ 广州站与新加坡站 Key **不互通**（`tokenhub.tencentmaas.com` vs `tokenhub-intl.tencentmaas.com`）。

### 3.2 改造 `callLLM`

保持**函数签名和返回值形状完全不变**（`{ success, content, error }`），
6 个调用点一行都不用改：

```ts
// 伪代码，骨架示意
export async function callLLM(options: AICallOptions): Promise<AICallResult> {
  for (const [index, slot] of chain.entries()) {
    if (isCooling(slot.key)) continue;          // 冷却中直接跳过，不白打
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await callOnce(slot, options);
      if (res.ok) { markOk(slot.key); return { success: true, content: res.content }; }

      const kind = classify(res.status, res.body);
      if (isRetryable(kind) && attempt < MAX_ATTEMPTS) { await backoff(attempt); continue; }
      markFailed(slot.key, kind);               // 打冷却
      break;                                    // 降下一档
    }
  }
  return { success: false, content: '', error: lastError };
}
```

关键：**某档配置不全（缺 Key）时也要能跳过**，不能让异常穿透整个循环
（见 §4-4）。

### 3.3 返回值带上"实际用了哪一档"

`AICallResult` 建议加一个可选字段：

```ts
export interface AICallResult {
  success: boolean;
  content: string;
  error?: string;
  /** 实际生效的档，如 "tokenhub:qwen3.5-plus"；用于事后追溯 */
  slot?: string;
  /** 命中档位下标：0 = 链头，>0 = 发生过降档 */
  chainIndex?: number;
}
```

**为什么重要**：不做前置评测时（见 §5），「事后查得出当时用的是哪一档」是唯一的质量兜底。

---

## 4. 必须避开的 5 个坑（都是真踩过的）

### 4-1. `pre-offline` 不能当"离线"剔除

`GET /v1/models` 的 `status` 有**三种**值：

| status | 含义 | 处理 |
|---|---|---|
| `online` | 正常在服 | 可用 |
| **`pre-offline`** | **已公告下线，但仍可调用** | ✅ **必须保留** |
| `discontinued` | 已停服 | 剔除 |

**踩坑经过**：最初只认 `status == "online"` 做白名单，结果把
`qwen3.5-plus` / `qwen3.5-flash` / `glm-5.1` / `glm-5` / `glm-5-turbo` / `kimi-k2.5`
**全部误剔** —— 恰好剔掉链头的整批目标，把改造的意义整个抹掉。

**正确做法**：用**黑名单**（只剔 `discontinued`），字段没见过时宁可保留。

### 4-2. `401006` 会被误判成"鉴权失败"

TokenHub 的业务错误码是 **6 位，前三位对应 HTTP 状态**。
所以 `401006`（endpoint is inactive）里带 "401"，走通用字符串匹配会被当成鉴权失败 → 白白降档。

**正确做法**：**优先特判** `401006` / `endpoint is inactive` → 归类为**瞬态，可重试**。

### 4-3. 额度耗尽的冷却不能照抄固定值

见 §2.3。TokenHub 额度不刷新，固定 6h 冷却 = 每 6 小时白打一次已永久耗尽的档。

### 4-4. 缺 Key 的档不能抛异常穿透降档循环

**踩坑经过**：链上某一档的 provider 没配 api_key 时，原实现直接抛配置异常；
而该异常**不是** LLM 错误族的子类 → 穿透了整个降档循环 → **整条链直接失败**。

后果：如果只配了 TokenHub 没配智谱（或反过来），**所有场景一起挂** ——
与"给 LLM 加容错"的目的正好相反。

**正确做法**：`slotAvailable()` 里就检查 provider 是否配了 key，没配直接跳过该档。

### 4-5. 参数不迁就模型 = 整档 400

不同模型对 `temperature` / `thinking` 的接受度**不一样**。实测（2026-09-18）：

| 模型 | 脾气 |
|---|---|
| `kimi-k2.5` | **只接受 `temperature=1.0`**（0.1 / 0.6 一律 400，业务码 `400001`） |
| `minimax-m2.7` | 发 `thinking: {type:"disabled"}` 也**关不掉**思考，不如干脆不发 |
| 其余 11 档 | 默认参数即可，全部支持 `response_format` |

**正确做法**：建一张 `MODEL_QUIRKS` 表，按模型名覆盖 `temperature` / 是否发 `thinking`，
**未登记的走默认**。不要凭猜测填 —— 用探针脚本实测（见 §6）。

> 好消息：本项目用原生 fetch，`body` 完全可控，比 SDK 更好处理这类差异。

---

## 5. 关于"要不要先评测再上"

QQBotForFun 的结论：**不做前置质量评测**。

理由：**验证成本 ≈ 被验证的资源本身**。14 条 golden × 13 档，光长 prompt 就要烧掉十几万 token，
而这批额度本就是「用完即弃」的临期资源——为了验证它而先烧掉它，不划算。

**替代方案**：**事后定点排查**

```
出问题时  翻日志里的 slot / chainIndex → 定位当时降到了哪一档
        → 只对那一档跑几条 golden（几千 token）
           而不是全量（十几万 token）
```

**代价要知悉**：链序是人工初判，没有质量数据支撑。理论上存在"某个新档判题反而更差"的可能。
若无法接受这个风险，就单独给狼人杀 AI 跑一批评测——但那要花额度。

---

## 6. 参考实现（QQBotForFun）

| 用途 | 文件 |
|---|---|
| **设计文档（含全部调研与取舍）** | `QQBotForFun/docs/plans/2026-09-17-llm-tokenhub-model-ladder.md` |
| 链调度 + 冷却 + 错误分类 | `QQBotForFun/src/core/llm.py` |
| 参数探针（测各档脾气） | `QQBotForFun/scripts/probe_tokenhub_models.py` |
| 诊断脚本（零额度消耗） | `QQBotForFun/scripts/llm_status.py` |
| 单元测试（35 个离线用例） | `QQBotForFun/tests/core/test_llm_ladder.py` |

**建议的落地顺序**：

1. 加 `TOKENHUB_API_KEY`，先只把 `callLLM` 改成"链 + 降档"，**链序先用 2 档**
   （`tokenhub:qwen3.5-plus` → 现有智谱兜底），跑通即可上线
2. 用探针脚本（或照抄它的思路写个 TS 版）测出各档的 `temperature` / `thinking` 脾气
3. 再把完整链铺开

---

## 7. 验收标准

- [ ] 链头故意配成不可用的档（如额度已耗尽）→ **自动降档并成功返回**，
      `chainIndex > 0`，日志能看出降级轨迹
- [ ] 冷却中的档**不再被真实调用**（不产生网络请求）
- [ ] 6 个 `callLLM` 调用点**一行都不用改**（对外签名未变）
- [ ] 全链不可用时返回 `{ success: false, error }`，调用方现有降级逻辑照常工作
- [ ] 诊断命令只读内存，**不发起推理调用**

---

## 8. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-09-18 | 初版：从 QQBotForFun 的落地经验整理，面向 SilentWereWolf 移植 |
| 2026-09-18 | 追加 §9：通读本项目代码后的因地制宜落地方案（超时预算重算、配置惰性读取、默认链零猜测、离线单测、两步上线） |

---

## 9. SilentWereWolf 落地方案（因地制宜修订）

> 本章是对上面 §1–§7 的**修订与细化**，依据是本项目当前的真实代码。与前文冲突处以本章为准。

### 9.0 目标：接入 TokenHub + 照抄 `silent_mark_ai` 的链

QQBotForFun 里与本项目同源的是 `silent_mark_ai`（静夜标记 AI 决策：高频、要 JSON、超时窗口紧）。
**本项目照抄这条链本身 —— 成员与顺序都不改。**

```
 1 tokenhub:qwen3.5-plus
 2 tokenhub:qwen3.5-flash
 3 tokenhub:hunyuan-role-latest
 4 tokenhub:hy-role
 5 tokenhub:deepseek-v4-flash-202605
 6 tokenhub:deepseek-v4-flash-0731
 7 tokenhub:glm-5.1
 8 tokenhub:glm-5
 9 tokenhub:glm-5-turbo
10 tokenhub:deepseek-v4-pro-202606
11 tokenhub:deepseek-v4-pro-0813
12 tokenhub:kimi-k2.5
13 tokenhub:minimax-m2.7
14 zhipu:glm-4-flash-250414        ← 链尾：另一家的免费池
```

**链成员 = QQBotForFun `silent_mark_ai` 的原文，一个字不改**（13 档 TokenHub + 1 档链尾）。不增、不减、不重排。

**这 14 档是已验证清单，本项目不复验**：13 档 TokenHub 已由 QQBotForFun 于 2026-09-18 用探针逐个实测（13/13 可调用、13/13 支持 `response_format`、额度未耗尽，`kimi-k2.5` 的 temperature 限制即出自该次实测）；链尾 `glm-4-flash-250414` 是其**现役生产模型**。本项目的待办只有「接入」，不含「复验」。

- provider `tokenhub`：`base_url = https://tokenhub.tencentmaas.com/v1`（OpenAI 兼容，走 `POST /chat/completions`），`api_key = ${TOKENHUB_API_KEY}`。
  ⚠️ 广州站与新加坡站 Key **不互通**（`tokenhub.tencentmaas.com` vs `tokenhub-intl.tencentmaas.com`）。
- 同参数：`temperature 0.3` / `max_tokens 1024` / `json_mode true`；单档超时照抄不来，见 §9.1-1。
- AI 取名在 QQBotForFun 是**另一条更短的链**（`silent_mark_ai_name`，10 档、temp 0.9、max 20）。本项目 `generateAIName` 只在添加 AI 时调一次 → **直接复用主链**，不单开一条。

**参数对齐（已定）**

| 参数 | 取值 | 依据 |
|---|---|---|
| `temperature` | 判断类 4 个调用点 **0.3**；`generateAIName` **0.9**（保持现值） | 0.3 不是"创意参数"，是**判断稳定度**参数：同一局里 AI 对同一局势前后翻供，是最容易被玩家看穿的破绽。输出的多样性**不该**由温度承担 —— 本项目已由 `AIPersona`（6 种分析偏好注入 prompt）+ 代码层受控随机兜底负责（`buildMarkingResult` 的嫌疑度排序与理由选择）。另外链上有弱档（链尾 `glm-4-flash`），温度越低 JSON 崩坏率越低 |
| `max_tokens` | 全部调用点统一提到 **1024**（现为 300–1000） | 这个参数只是**输出上限**，不生成就不消耗 → "砍"没有任何收益。而链上多数档**默认开思考**（实测 12/13 返回 `reasoning_content`），300 的上限在"思考 + JSON"并存时有截断风险；截断的表现就是 JSON 不完整 → 白多一次重试，反而更慢。`marking` 输出最长（analysis + 最多 N 条评价），最需要这个余量 |
| `json_mode` | `true`（必须带 §9.1-5 的两条兜底） | 13 档实测全部支持 |
| 链尾 | `zhipu:glm-4-flash-250414`（与 QQBotForFun 逐字一致） | 这**不是"未经证实"的档**：它是 QQBotForFun 的现役生产模型，一直在跑。而我们这边的 `glm-4-flash` 只是旧配置、没有验证记录 —— **保留现状才是引入未知**。`ZHIPU_MODEL` 环境变量不再参与链配置 |
- 链序语义（照抄）：**剩余寿命升序 + 组内质量降序**。链头那批 `pre-offline` 档（qwen3.5-\*、glm-5 系、kimi-k2.5）额度不用就是作废；A 类档耗尽/下线后 TokenHub 这段会**整段归零**、落到链尾智谱 —— 已知并接受。

### 9.1 照抄之外只需处理这 4 处

| # | QQBotForFun 的做法 | 本项目必须改成 | 原因 |
|---|---|---|---|
| 1 | 单档超时 30s、`retries: 3`、**没有整链上限** | 单档 12s、单档最多 2 次（退避 1s）、**整链 20s 预算**；`AI_ACTION_TIMEOUT_MS` **保持 60s 不动** | `withTimeout(decideXxx, 60s)` 是硬上限且**包住了思考 sleep**（marking 最坏 32s），照抄会让链头一超时就吃光预算。但**不能抬这个上限**：项目给玩家展示的阶段计时是 `settings.timers`（夜晚 20s / 投票 30s / 触发 60s），抬到 90s 会让真人干等超出自己的倒计时 —— 正确做法是反过来收紧链内预算 |
| 2 | `retries: 3` + backoff 1/2/4s | 单档 2 次（含首次）、退避 1s | 最坏单档 3×12s + 7s ≈ 43s，一档就吃掉整链预算。**不另做 provider 级熔断**：档级冷却已覆盖同一场景（见 §9.12 演练），少一个活动部件、更贴近照抄 |
| 3 | `json_mode: true` + 两条兜底 | 跟，但两条兜底必须一起搬：① system prompt 里没有 "json" 字样时补一句英文 JSON 约束；② 返回 400 且信息含 `response_format` → **去掉该字段重发一次（不降档、不冷却）** | 本项目的 JSON 要求写在 user prompt、system 里没有 → ① 一定触发；没有 ② 的话，万一某档不支持会整档 400 被冷却。（13 档实测都支持，② 是防呆） |
| 4 | 启动时 `GET /v1/models` 裁剪死档 | 照抄，但**必须用黑名单**（只剔 `discontinued` / `offline` / `retired`） | 不消耗推理额度；不做的话，已停服的档在冷却封顶后会每天被白打一次。⚠️ 若只认 `status == "online"`，链头那 7 个 `pre-offline` 档（qwen3.5-\*、glm-5.\*、kimi-k2.5）会被**全部误剔** —— QQBotForFun 已经踩过这个坑 |

**照抄时注意**：`kimi-k2.5` 只接受 `temperature=1.0`（否则 400 / 业务码 `400001`，会被判 fatal 白冷却 10min），quirks 表要照抄且**优先级高于调用点传的 temperature**；`minimax-m2.7` 的 `thinking` 关不掉那类问题本项目**不用管**（请求体从不发 `thinking`，天然正确）。

> ⚠️ **额度与共用（2026-09-18 用户口径）：允许与 QQBotForFun 共用、一起烧，不必为"预留资源"而裁剪链。**
> - **但链成员照抄 `silent_mark_ai` 原文，不增不减**（见 §9.0）。"允许一起烧"解除的是"不能烧"的顾虑，**不是**往链里加模型。
> - **额度按账号算，换 Key 不隔离额度**：同一腾讯云账号下新开一把 Key，烧的仍是同一个池，只是认证串不同。要真正隔离额度只能换账号。
> - **链的顺序不改变烧的速度，只决定"先烧谁"**：真正决定烧完快慢的是**调用量**（AI 玩家数 × 对局数 × 每局决策次数）。所以"加速烧"的正确做法是把可用档**全部串进来**（多池并行消耗），而不是靠排序。
> - **推论（要知情）**：链只会用到"当前第一个可用档"。如果总调用量 < 总免费额度，**链尾那批在过期前可能一次都轮不到**。要避免漏烧只能提高调用量，排序救不了。
> - 两个进程的冷却表**不共享**：同一档被一边判为耗尽后，另一边仍会去试一次 402。可接受，排障时要知道"另一个项目也在烧同一批额度"。
> - 两边并发加起来可能撞 429 —— 这正是"限流就地重试、不降档"存在的意义。

### 9.2 超时预算（最关键的一条）

现状：

```
handlers.ts: withTimeout(decideXxx(...), 60_000)           ← 外层硬上限，且包住 sleep
  AIPlayerController: sleep(2–15s × persona 1.2 × 异常 1.8) ← 最坏 marking ≈ 32s
    AIApiClient: REQUEST_TIMEOUT_MS = 60_000               ← 内层，与外层等长
```

**内层超时永远不会先触发。** 链一多档，外层先炸 → 直接 `fallbackXxx()`，链上后面几档一次都打不到。

建议值（均可由环境变量覆盖）：

| 参数 | 默认 | 说明 |
|---|---:|---|
| `LLM_ATTEMPT_TIMEOUT_MS` | 12000 | 单档单次请求超时（照抄的 30s 太长） |
| `LLM_SLOT_ATTEMPTS` | 2 | 单档最多尝试次数（含首次），只对限流/抖动生效 |
| `LLM_CHAIN_BUDGET_MS` | 20000 | 一次 `callLLM` 内所有档的总预算；用完立即返回失败，不再打后面的档 |
| `AI_ACTION_TIMEOUT_MS`（`handlers.ts` 常量） | **60000（保持原值）** | 最坏 32s(sleep) + 20s + 20s 会超出 60s，由外层截断并走既有兜底 —— 不劣于改造前 |

正常路径反而更快：卡住的档 12s 就换，不再像现在这样干等到 60s 才走兜底。

附带改善：现在一个卡住的档要干等到外层 60s 才走兜底；改造后 15s 就换档。

### 9.3 配置必须改成惰性读取（本项目既有隐患）

`AIApiClient.ts` 在**模块顶层**读 `process.env`，而 `index.ts` 的 `dotenv.config()` 在第 13 行、晚于所有 import 求值：

```
import { registerSocketHandlers } from './socket/handlers'  ← 此时 env 已读完
...
dotenv.config({ path: ../.env })                            ← 太晚了
```

该时序已实测确认（`module-top saw: none | body sees: set`）。含义：

- 生产没事：Docker `env_file` 直接把变量注入 `process.env`；
- 但**本地放 `.env` 对 AI 完全不生效**。而这次要新增 `TOKENHUB_API_KEY` 并本地验证，不修就测不了。

做法：改为 `loadConfig()`（首次调用时读取 + memoize），不再用顶层常量。顺带收益：单测可注入配置，`testAIConnection` 读到的是当前值而非加载时快照。

本地验证优先用**进程级**变量（不落盘）：

```powershell
$env:TOKENHUB_API_KEY = '<临时粘贴>'
$env:TOKENHUB_MODEL   = '<实测可用的模型名>'
cd d:/Fun/SilentWereWolf/server; npx tsx index.ts
```

### 9.4 代码落点

| 文件 | 动作 |
|---|---|
| `server/game/ai/AIProviderLadder.ts` | **新增**：链解析、槽位可用性、错误分类、冷却表、`getLadderStatus()`。纯逻辑、不碰网络 |
| `server/game/ai/AIApiClient.ts` | 改：`callLLM` 变编排（逐档 → `callOnce` → 分类 → 冷却/降档）；`testAIConnection` 改判"链上是否有可用档"，message 带实际生效档 |
| `server/game/ai/AIPlayerController.ts` | 改：4 处 `logAIDecision` 各加 `model: result.slot`（**对外调用签名不变**） |
| `server/game/ai/AILogger.ts` | 改：`AILogEntry` 加可选 `model?: string`（内部接口，前端不消费日志） |
| `server/socket/handlers.ts` | **无改动**（`AI_ACTION_TIMEOUT_MS` 保持 60s）。`room:testAI` 缺房主校验的问题另见 §11-3 |
| `server/game/ai/__tests__/*.test.ts` | **新增**：离线单测（vitest `include` 已覆盖 `server/**/__tests__/**/*.test.ts`） |
| 不动 | `shared/`、`client/`、`docker-compose.yml`、`Dockerfile` |

槽位语法与 provider 表：

| 前缀 | Key | BaseURL |
|---|---|---|
| `tokenhub:` | `TOKENHUB_API_KEY` | `https://tokenhub.tencentmaas.com/v1`（OpenAI 兼容，已在 QQBotForFun 侧跑通；保留 `TOKENHUB_BASE_URL` 可覆盖） |
| `zhipu:` | `ZHIPU_API_KEY` | `ZHIPU_BASE_URL`，默认 `https://open.bigmodel.cn/api/paas/v4` |
| 其他前缀 | — | 跳过 + warn |

### 9.5 错误分类与冷却（本项目最终版）

| 情形 | 分类 | 本轮动作 | 冷却（照抄 QQBotForFun） |
|---|---|---|---|
| 429 | `rate_limited` | 退避重试（本项目最多 2 次）；耗尽 → 降档 | 35s |
| 402 / 402xxx | `quota_exhausted` | **不重试**，立即降档 | 6h → 12h → 24h 递增封顶（成功一次清零） |
| 401 / 403 | `auth` | 不重试，降档 | 30min |
| 404 | `unavailable` | 不重试，降档 | 24h |
| 400 且信息含 `model` + `not found` / `not exist` / `invalid` | `unavailable` | 不重试，降档 | 24h |
| 其他 400 | `fatal` | 先按 §9.1-5 去掉 `response_format` 重发一次；仍 400 则降档 | 10min |
| 5xx / 超时 / 网络异常 / `401006` / `endpoint is inactive` | `transient` | 退避重试（最多 2 次）；耗尽 → 降档 | 20s |
| 输出不是合法 JSON | **不算档位故障** | 档内重试；仍不合规 → 标记该档正常后降档 | **不冷却** |
| 该 provider 连续失败若干档 | — | 跳过该 provider 剩余所有档（§9.1-2） | provider 级 2min |

- 冷却状态 = 模块级 `Map<slotKey, {until, failKind, exhaustCount}>`。Node 单进程单容器，**不需要分布式协调**，与现有 `RoomManager` 的内存模型一致。
- 成功一次 → `exhaustCount = 0`（保留自愈路径）。
- 所有档都在冷却 → **立刻返回 `{success:false}`**，不发请求、不等待（让调用方的二次调用与兜底都很快）。
- 容器重启/每次部署清空冷却表，已耗尽的档会被重打一次。可接受，不做持久化。

### 9.6 可观测

- 降档时 `console.warn('[LLMLadder] ...')`；**`chainIndex > 0` 时即使成功也 warn**（"这局 AI 用的是次档"是质量风险的唯一早期信号）。
- 启动时打印链（不含密钥，不可用档标 `(skip: no key)`）。
- 生产排查：`docker compose -p silentwerewolf logs --tail=500 silentwerewolf | grep LLMLadder`；本地对照 `server/logs/ai/*.json` 里的 `model` 字段。
- `AICallResult` 增加可选 `slot` / `chainIndex`（向后兼容）。

### 9.7 离线单测（零额度消耗）

`vi.stubGlobal('fetch', ...)` + 假时钟，全部离线：

1. 链头 402 → 降档后成功，`success:true` 且 `chainIndex > 0`
2. 冷却中的档**不产生 fetch 调用**（断言调用次数）
3. 429 → 同档重试，第 2 次成功，`chainIndex === 0`
4. 400 → 跳过该档且**不写冷却**（下次调用仍会尝试它）
5. `401006` → 判为瞬态可重试，**不判为 auth**
6. 缺 `TOKENHUB_API_KEY` 的档 → 跳过、不抛异常、链继续（防"配置异常穿透整条链"）
7. 全链失败 → `{success:false, error}`，且每档只被打一次
8. 额度耗尽连续 3 次 → 冷却 6h / 12h / 24h（假时钟断言）
9. 成功一次 → `exhaustCount` 清零
10. `LLM_MODEL_CHAIN` 解析容错（空串 / 含空格 / 非法前缀 / 重复档）
11. 整链预算耗尽 → 提前停止，后面的档一次都不打
12. `/v1/models` 裁剪：`pre-offline` 的档**必须保留**，只剔 `discontinued`（QQBotForFun 的同款回归用例）
13. `/v1/models` 拉取失败时不抛异常、不裁剪链路（不阻断启动）
14. 启动日志打印完整链序，且**不回显密钥**

### 9.8 部署、密钥与版本

- 生产密钥文件 `/root/silentwerewolf-secrets/silentwerewolf.env` 追加 `TOKENHUB_API_KEY=`，可选 `LLM_MODEL_CHAIN=`（不是密钥，但放同一份文件最省事：compose 与镜像都不用改）。严禁写进 Lighthouse 命令、日志、聊天、截图。
- `docs/operations.md` §4.1 环境变量表补 `TOKENHUB_API_KEY` / `LLM_MODEL_CHAIN`；§11 部署状态在发布后更新。
- **两步上线（本项目专属灰度路径）**：
  1. 先只发代码、**不配** `TOKENHUB_API_KEY` → 链退化为单档 `zhipu:glm-4-flash`，行为与现状等价（仅超时/重试语义按 §9.2 收紧），零风险上线；
  2. 观察一天无异常后，在服务器密钥文件里补 key 与链序 → `docker compose -p silentwerewolf up -d`（env 变化会 recreate 容器，**会中断进行中的对局**，挑空闲时段）。
- 版本 `0.2.2 → 0.3.0`（新功能）：三处 `package.json` + `CHANGELOG.md` 顶部同步，用用户视角描述（例："AI 在某个模型不可用时自动切换备用模型，减少 AI 卡壳"）。
- **链路无需任何前置验证**：14 档全部来自 QQBotForFun 的已验证清单（13 档探针实测 + 链尾为现役生产模型）。本项目待办只有「接入」，不含「复验」。

### 9.9 实施顺序

- [x] 1. `AIProviderLadder.ts`（链解析 / 错误分类 / 冷却 / `/v1/models` 裁剪 / 零消耗诊断）+ 配置惰性读取
- [x] 2. `callLLM` 改为链编排；链内预算 20s；`AI_ACTION_TIMEOUT_MS` **保持 60s**（§11-1）
- [x] 3. `testAIConnection` 走链并报出**实际生效档**；`jsonMode` + `response_format`（含退化与 JSON 校验）；`AILogEntry.model` + 4 处调用点
- [x] 4. 启动打印链路 + 启动裁剪（`server/index.ts`）
- [x] 5. 本地验收：`npx tsc --noEmit -p server/tsconfig.json` 通过；`npx vitest run` **52 passed**（其中本特性 20 个用例）；无效 key 真实网络演练通过（§9.12）
- [ ] 6. 发布前：`docs/operations.md` 环境变量表 + `CHANGELOG.md` + 三处 `package.json`（0.2.2 → 0.3.0）
- [ ] 7. 服务器补 `TOKENHUB_API_KEY` 后重启，按 §9.12 的方式 `grep LLMLadder` 确认链生效

### 9.10 明确不做（YAGNI）

不做 per-scene 链（一条全局共享链） · 不做前置质量评测（沿用 QQBotForFun 的结论：**验证成本 ≈ 被验证的资源本身**） · 不做冷却持久化 · 不做 Redis/分布式锁 · 不做前端 AI 状态面板 · 不实现 `thinking` quirks 通道（本项目从不发该字段） · 不引入 openai SDK（保持原生 fetch，理由见 `AIApiClient` 顶部注释） · 不改 `shared/` 与 `client/`。

### 9.11 风险与对策

| 风险 | 对策 |
|---|---|
| 链序是人工初判，可能把更差的档放前面 | 用日志 / 复盘里的 `model` 字段定位到具体档再补测；调序只改 `LLM_MODEL_CHAIN`，不动代码 |
| 降档后 AI 变蠢而无人察觉 | 降档成功时打 `[LLMLadder] 本次降档生效 slot=... chainIndex=N`；AI 复盘日志带 `model` |
| 外层超时把链"截断" | §9.2：单次请求超时按剩余预算收敛，整链预算是硬上限 |
| 某档意外挂掉 | 14 档互为备胎，坏档按类型冷却后跳过，不影响其他档（§9.12 已实测） |
| 补 key 需重启容器、中断对局 | 挑空闲时段；密钥文件与镜像无关，不影响回滚能力 |

---

## 10. 实测记录（本项目本地演练，2026-09-18）

用**无效** TokenHub Key（不涉及任何真实密钥）真实打一次，验证链路行为：

| 验证项 | 结果 |
|---|---|
| TokenHub 域名可达（真实网络） | ✅ `https://tokenhub.tencentmaas.com/v1` 返回真实业务错误 |
| 业务码解析 | ✅ 错误文本带 `401002`（API Key 无效），**未被误判**为瞬态 |
| 鉴权失败处理 | ✅ 逐档 `kind=auth` 冷却 **1800s**，不重试、立即降档 |
| 缺 key 的档 | ✅ 链尾 `zhipu:glm-4-flash-250414` 标记 `no_key` 直接跳过，**不抛异常穿透整条链** |
| 全链不可用 | ✅ 干净返回 `{success:false, error}`，调用点既有兜底逻辑不受影响 |
| 耗时 | ✅ 13 档全部失败仅 **559ms**（鉴权失败不重试，开销极小） |
| 启动日志 | ✅ 打印 14 档完整链序，**不回显密钥** |
| `/v1/models` 失败 | ✅ 仅 warn，不裁剪、不阻断启动 |

**未验证项（不在此处伪造结论）**：真实 Key 下的正常调用与降档（需要有效密钥，属部署阶段动作）。

### 变更日志（本章）

| 日期 | 变更 |
|---|---|
| 2026-09-18 | 落地实现：`AIProviderLadder.ts` + `callLLM` 链编排 + jsonMode/quirks + 20 个离线用例 + 本地演练 |
| 2026-09-18 | 撤销未实现的 provider 级熔断（档级冷却已覆盖，少一个活动部件） |

---

## 11. 与项目既有约定的一致性审查（2026-09-18）

实现完成后逐条对照项目规范 / 既有代码做的复查，**7 项，已全部处理**：

| # | 发现 | 性质 | 处理 |
|---|---|---|---|
| 1 | 我先把 `AI_ACTION_TIMEOUT_MS` 抬到 90s —— **方向错了** | 与产品计时冲突 | **已撤回，保持 60s**。项目给玩家展示的阶段计时是 `settings.timers`（夜晚默认 20s / 投票默认 30s / 触发固定 60s）；抬上限会让真人等到自己倒计时归零后继续干等。正确做法是保持外层不变、把**链内预算**收紧到 20s |
| 2 | `ZHIPU_MODEL` 变成**死配置** | 文档漂移 | 链里的模型名是照抄的，该变量不再参与任何逻辑。`docs/operations.md` §4.1 仍写着"默认 glm-4-flash" → 发布前必须标注弃用/删除，否则运维会以为改它能换模型 |
| 3 | `room:testAI` **没有房主校验**，且现在会回传"实际生效档" | 权限 / 信息面 | 缺校验是既有问题，但**被我的改动放大**（开始对外暴露链路档名）。已把给前端的错误文本截断到 120 字、完整错误只进日志；**校验没加**（那是独立改动，等你决定） |
| 4 | 测试文件原先放在 `server/game/ai/__tests__/` | 目录规范 | **已移动**到 `server/game/__tests__/`（架构规范里写明的游戏逻辑测试目录，与既有 4 个测试同处） |
| 5 | 我自加了 `LLM_MODEL_CHAIN` 环境变量 | 范围外增项 | QQBotForFun 的链写在 `config/llm.yaml`（改配置不改代码），本项目没有配置文件体系，用环境变量做等价物。**你没要求，要删说一声**（删掉则链只存在于代码里） |
| 6 | `temperature 0.3` 与「AI 要像真人」存在张力 | 知情项 | 本项目专门做了 `AIPersona`（6 种分析偏好）+ 代码层受控随机来制造差异；0.3 让判断更稳但也更趋同。若实测发现多个 AI 的 `analysis` 文本雷同，应先改 prompt 而不是回抬温度 |
| 7 | 严格 `JSON.parse` 校验 vs 调用点宽松的 `extractJSON` | 轻微不一致 | 按"照抄"要求做严格校验：若模型把推理文字混进 `content`，会被判非法 → 档内重试 → 降档，而调用点其实能解析。实测 13 档均支持 `response_format`、思考内容走 `reasoning_content`，风险低；真出现误降档再放宽 |

**未列入**（属已声明的待办，不是不一致）：`docs/operations.md` 环境变量表、`CHANGELOG.md`、三处 `package.json` 版本号（0.2.2 → 0.3.0）。
