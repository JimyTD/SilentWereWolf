# 《静夜标记》功能规格文档

> 版本：v0.1 草案  
> 更新日期：2026-03-02  
> 状态：待确认  
> 依赖：游戏设计文档 `game-design.md`

本文档定义系统功能的技术实现规格，面向开发。游戏规则和玩法设计见 `game-design.md`。

---

## 一、技术架构概览

### 1.1 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + Vite + Tailwind CSS |
| 前端状态管理 | Zustand |
| 后端 | Node.js + Express + Socket.IO |
| 数据存储 | 内存（通过 GameStore 抽象层，后续可替换为 Redis/SQLite） |
| 通信协议 | WebSocket（Socket.IO） |
| 语言 | TypeScript（严格模式） |
| 测试 | Vitest（覆盖游戏核心逻辑） |

### 1.2 部署架构

```
浏览器 ←→ Socket.IO ←→ Node.js 服务器（单进程）
                         ├── 房间管理（内存）
                         └── 游戏状态（内存）
```

首版为单服务器架构，所有房间和游戏状态通过 `GameStore` 抽象层管理，首版使用内存实现。服务器重启后数据丢失（可接受，游戏为短局制）。后续如需支持持久化或异步长局，可将 `GameStore` 替换为 Redis/SQLite 实现，无需改动业务逻辑。

### 1.3 端口约定

| 服务 | 端口 |
|------|------|
| 前端开发服务器（Vite） | 5173 |
| 后端服务器 | 3000 |

开发环境下前端通过 Vite proxy 代理 WebSocket 和 API 请求到后端。

---

## 二、用户系统

### 2.1 游客模式（首版）

首版不做账号注册/登录，采用纯游客模式。

#### 身份标识

- 用户首次访问时，前端生成一个 **UUID v4** 作为用户唯一标识（`userId`）
- `userId` 存储在浏览器 `localStorage` 中，持久化
- 每次连接 Socket.IO 时，将 `userId` 作为握手参数发送给服务端
- 服务端以 `userId` 识别用户身份（重连、恢复状态等）

#### 昵称

- 用户在首页输入昵称（`nickname`），2-8 个字符
- 昵称存储在 `localStorage`，下次访问自动填充
- 昵称在同一房间内唯一，不同房间可重复
- 进入房间时服务端校验昵称唯一性，冲突时提示用户修改

#### 数据结构

```javascript
// 前端 localStorage
{
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "nickname": "玩家A"
}

// 服务端用户信息（内存中，与 socket 关联）
{
  userId: "550e8400-e29b-41d4-a716-446655440000",
  nickname: "玩家A",
  socketId: "socket_xxx",        // 当前 socket 连接 ID
  roomId: "123456",              // 当前所在房间，null 表示不在房间
  connected: true                // 是否在线
}
```

### 2.2 后续扩展（不在首版范围）

- 账号注册/登录（邮箱、微信）
- 战绩统计、历史记录
- 好友系统

---

## 三、房间系统

### 3.1 房间生命周期

```
创建 → 等待中(waiting) → 游戏中(playing) → 结算(finished) → 等待中(waiting)
                                                                ↑ 房主开新局
```

房间在以下情况下销毁：
- 房间内所有人离开
- 房间空闲超过 30 分钟（无人在线）

### 3.2 创建房间

#### 请求

Socket 事件：`room:create`

```javascript
{
  settings: {
    mode: "preset" | "custom",         // 预设模板或自定义
    preset: "4standard" | "5standard" | "5strategy" | "6standard" | "9standard",  // mode=preset 时
    roles: {                           // mode=custom 时，各角色数量
      werewolf: 1,
      seer: 0,
      witch: 1,
      hunter: 0,
      guard: 1,
      gravedigger: 0,
      fool: 0,
      knight: 0,
      wolfKing: 0,
      villager: 1
    },
    items: {
      enabled: true,                   // 物品系统总开关
      pool: ["moonstone", "balance"]   // 启用的物品类型
    },
    timers: {
      marking: 60,                     // 标记阶段时长（秒）
      voting: 30,                      // 投票阶段时长（秒）
      nightAction: 20                  // 夜晚操作时长（秒）
    },
    lastWords: false,                  // 遗言开关
    deepMode: false                    // 4人局深度模式（两条命+双遗物）
  }
}
```

#### 响应

```javascript
// 成功
{
  success: true,
  roomId: "123456",                    // 6位数字房间号
  room: { /* 房间完整信息 */ }
}

// 失败
{
  success: false,
  error: "INVALID_CONFIG",             // 错误码
  message: "角色配置不合法：至少需要1个狼人"
}
```

#### 配置校验规则

- 总人数 ≥ 4
- 狼人数量 ≥ 1
- 好人数量 > 狼人数量
- 角色总数量不可超过 12（首版上限）
- 预设模板的角色配置不可修改

#### 房间号生成

- 6 位纯数字，范围 100000-999999
- 随机生成，检查与现有房间不冲突
- 房间销毁后房间号回收

### 3.3 加入房间

#### 请求

Socket 事件：`room:join`

```javascript
{
  roomId: "123456",
  nickname: "玩家A"
}
```

#### 响应

```javascript
// 成功
{
  success: true,
  room: { /* 房间完整信息 */ }
}

// 失败
{
  success: false,
  error: "ROOM_NOT_FOUND" | "ROOM_FULL" | "GAME_IN_PROGRESS" | "NICKNAME_TAKEN",
  message: "房间不存在"
}
```

#### 规则

- 房间状态为 `waiting` 时才能加入
- 昵称不能与房间内已有玩家重复
- 加入后自动分配座位号（1 ~ 最大人数）
- 如果该 `userId` 已在房间中（重连场景），恢复原有座位

### 3.4 离开房间

Socket 事件：`room:leave`

- 等待中离开：直接移除，座位释放
- 游戏中离开：触发掉线处理（见 3.7）
- 房主离开：自动转移房主给下一位玩家；无人则销毁房间

### 3.5 房主操作

#### 踢出玩家

Socket 事件：`room:kick`

```javascript
{ targetUserId: "xxx" }
```

- 仅房主可操作，仅等待中可踢人
- 被踢玩家收到 `server:kicked` 事件

#### 修改配置

Socket 事件：`room:updateSettings`

```javascript
{ settings: { /* 同创建时的 settings */ } }
```

- 仅房主可操作，仅等待中可修改
- 修改后广播 `server:roomUpdate` 给房间内所有人

#### 开始游戏

Socket 事件：`room:startGame`

- 仅房主可操作
- 校验：当前人数 = 配置的角色总数
- 通过后进入游戏初始化流程

### 3.6 房间广播事件

以下事件由服务端广播给房间内所有玩家：

| 事件 | 触发时机 | 数据 |
|------|---------|------|
| `server:roomUpdate` | 房间信息变化 | 房间完整信息 |
| `server:playerJoined` | 新玩家加入 | 玩家信息 |
| `server:playerLeft` | 玩家离开 | userId |
| `server:kicked` | 被踢出（仅发给被踢者） | 原因 |
| `server:gameStart` | 游戏开始 | 各自的身份信息 |

### 3.7 掉线与重连

#### 掉线检测

- Socket.IO 内置心跳机制检测断线
- 玩家断线后服务端将其标记为 `connected: false`
- 保留位置 **60 秒**

#### 重连

- 玩家重新连接后，携带 `userId` 握手
- 服务端匹配到该 `userId` 的房间和座位，恢复状态
- 推送当前完整游戏状态给重连玩家

#### 超时未重连

等待中：移除玩家，释放座位

游戏中（按当前阶段处理）：

| 阶段 | 超时行为 |
|------|---------|
| 夜晚行动 | 视为不操作（守卫不守、狼人由其他狼人决定、女巫不用药、预言家不查） |
| 标记发言 | 跳过该玩家的标记回合 |
| 投票阶段 | 系统随机投票（不投自己） |
| 特殊触发（猎人/白狼王/骑士） | 视为不操作（不开枪/不带人/不决斗） |

### 3.8 房间数据结构

```javascript
{
  roomId: "123456",
  status: "waiting" | "playing" | "finished",
  hostUserId: "xxx",                   // 房主
  settings: { /* 同 3.2 */ },
  players: [
    {
      userId: "xxx",
      nickname: "玩家A",
      seatNumber: 1,                   // 座位号
      connected: true,
      ready: false                     // 预留：准备状态
    }
  ],
  createdAt: 1709337600000,
  lastActivityAt: 1709337600000        // 用于空闲超时检测
}
```

---

## 四、游戏核心流程

### 4.1 游戏初始化

房主点击开始后，服务端执行：

1. **分配身份**：将配置的角色随机分配给每位玩家
2. **分配物品**：从启用的物品池中随机为每位玩家分配物品（深度模式分配 2 个）
3. **计算固定物品值**：天平徽章根据座位和阵营立即计算
4. **初始化游戏状态**：回合数、阶段、各角色技能使用状态
5. **狼人互认**：向所有狼人推送队友信息
6. **推送身份**：向每位玩家单独推送自己的身份和物品类型

#### 推送给各玩家的初始数据

```javascript
// server:gameStart（单独发给每个玩家）
{
  role: "seer",                        // 自己的角色
  faction: "good",                     // 阵营
  seatNumber: 3,                       // 座位号
  items: ["moonstone"],                // 自己的物品类型（看不到内容）
  teammates: [],                       // 狼人阵营可看到队友 userId 和座位号
  players: [                           // 所有玩家的公开信息
    { userId: "xxx", nickname: "玩家A", seatNumber: 1, alive: true }
  ],
  settings: { /* 房间设置 */ },
  phase: "night",                      // 当前阶段
  round: 1                             // 当前回合
}
```

### 4.2 阶段状态机

```
night → day_announcement → day_hunter → day_knight → day_marking → day_voting → day_trigger → night
                                                                                      ↓
                                                                                  game_over
```

| 阶段 | 说明 | 超时 |
|------|------|------|
| `night` | 夜晚行动（各角色按顺序操作） | 各角色独立计时 |
| `day_announcement` | 公布死讯 + 遗物公开 | 自动推进，无需操作 |
| `day_hunter` | 猎人开枪（如被刀死触发） | nightAction 时长 |
| `day_knight` | 骑士决斗（如有骑士且未使用） | nightAction 时长 |
| `day_marking` | 标记发言（按顺序依次进行） | marking 时长 × 存活人数 |
| `day_voting` | 放逐投票 | voting 时长 |
| `day_trigger` | 放逐后特殊触发（白痴/白狼王/猎人） | 每个触发独立计时 |
| `game_over` | 游戏结束，展示结算 | — |

#### 阶段推进

- 每个阶段结束后，服务端自动判断下一阶段
- 中间穿插胜负检查：任何出局事件后立即检查
- 阶段切换时广播 `server:phaseChange` 给全体

### 4.3 夜晚流程

服务端按固定顺序依次通知各角色操作：

```
1. server:nightAction → 守卫（如有）
   ← client:nightAction { action: "guard", target: userId }

2. server:nightAction → 狼人们
   ← client:nightAction { action: "attack", target: userId }
   （多个狼人需达成一致，如超时未统一则随机选其中一个提交的目标）

3. server:nightAction → 女巫（如有）
   // 先告知谁被刀
   server:witchInfo { victim: userId | null }
   ← client:nightAction { action: "usePotion", potion: "antidote" | "poison" | "none", target: userId }

4. server:nightAction → 预言家（如有）
   ← client:nightAction { action: "investigate", target: userId }
   server:investigateResult { target: userId, faction: "good" | "evil" }

5. server:nightAction → 守墓人（如有）
   ← client:nightAction { action: "autopsy", target: userId }
   server:autopsyResult { target: userId, faction: "good" | "evil" }
```

每个角色有独立的操作倒计时（`nightAction` 秒），超时视为不操作。

夜晚所有角色操作完毕后，服务端统一结算（见设计文档 5.2），然后推进到白天。

### 4.4 白天流程

#### 公布死讯（day_announcement）

```javascript
// server:dayAnnouncement
{
  deaths: [
    {
      userId: "xxx",
      seatNumber: 3,
      cause: "attacked" | "poisoned",  // 死因（不公开身份）
      relics: [                        // 死亡时公开的遗物
        { type: "moonstone", value: 3 }
      ]
    }
  ],
  peacefulNight: false                 // 是否平安夜
}
```

#### 猎人开枪（day_hunter）

仅当猎人被刀死或被放逐时触发（被毒死不触发）。

```javascript
// server:hunterTrigger → 猎人
{ canShoot: true, timeout: 20 }

// client:hunterAction
{ action: "shoot" | "skip", target: userId }

// server:hunterResult → 全体
{ shooter: userId, target: userId | null, targetDeath: true | false }
```

#### 骑士决斗（day_knight）

```javascript
// server:knightTurn → 骑士
{ canDuel: true, timeout: 20 }

// client:knightAction
{ action: "duel" | "skip", target: userId }

// server:duelResult → 全体
{ loser: userId }  // 不公开身份，不说明谁是骑士谁是目标
```

#### 标记发言（day_marking）

按座位顺序（或系统确定的发言顺序）依次进行：

```javascript
// server:markingTurn → 当前发言玩家
{ yourTurn: true, timeout: 60 }

// client:submitMarks
{
  identityMark: {                     // 身份声明
    identity: "seer",                 // 声明的身份
    reason: "intuition"               // 理由
  },
  evaluationMarks: [                  // 评价标记
    {
      target: userId,
      identity: "werewolf",           // 评价身份
      reason: "vote_analysis"         // 理由
    }
  ]
}

// server:marksRevealed → 全体
{
  player: userId,
  identityMark: { ... },
  evaluationMarks: [ ... ]
}
```

标记理由枚举：

```javascript
// 通用理由
const COMMON_REASONS = {
  intuition: "直觉判断",
  vote_analysis: "基于投票的分析",
  mark_analysis: "基于标记的分析",
  log_reasoning: "基于日志的推理"
};

// 专属理由
const SPECIAL_REASONS = {
  investigation: "【查验结论】",       // 声明预言家或守墓人时可用
  potion_result: "【用药结果】"        // 声明女巫时可用
};
```

#### 放逐投票（day_voting）

```javascript
// server:votingStart → 全体
{ timeout: 30, candidates: [userId, ...] }  // 候选人 = 所有存活且有投票权的玩家

// client:vote
{ target: userId }  // 不可投自己，不可弃票

// server:votingResult → 全体
{
  votes: [                            // 所有投票记录（公开）
    { voter: userId, target: userId }
  ],
  exiled: userId | null,              // 被放逐者，平票则 null
  tie: false                          // 是否平票
}
```

#### 放逐后特殊触发（day_trigger）

按顺序检查：白痴免疫 → 白狼王带人 → 猎人开枪

每个触发的事件格式与对应角色的独立事件相同。

### 4.5 胜负判定

每次出局事件后执行：

```javascript
function checkWinCondition(gameState) {
  const aliveWolves = getAliveByFaction("evil");
  const aliveGood = getAliveByFaction("good");
  const aliveVillagers = getAliveByRole("villager");
  const aliveSpecials = aliveGood.filter(p => p.role !== "villager");

  // 好人胜：所有狼人出局
  if (aliveWolves.length === 0) return "good";

  // 狼人胜（屠边）：所有神职出局 或 所有平民出局
  if (aliveSpecials.length === 0) return "evil";
  if (aliveVillagers.length === 0) return "evil";

  return null; // 游戏继续
}
```

#### 游戏结束推送

```javascript
// server:gameOver → 全体
{
  winner: "good" | "evil",
  players: [                          // 所有玩家完整信息
    {
      userId: "xxx",
      nickname: "玩家A",
      seatNumber: 1,
      role: "seer",
      faction: "good",
      alive: false,
      items: [{ type: "moonstone", value: 3 }]
    }
  ],
  history: {                          // 完整对局历史
    rounds: [ /* 每回合的行动记录 */ ],
    marks: [ /* 所有标记记录 */ ],
    votes: [ /* 所有投票记录 */ ]
  }
}
```

---

## 五、游戏状态管理

### 5.1 服务端游戏状态结构

```javascript
{
  roomId: "123456",
  status: "playing",
  round: 2,
  phase: "day_marking",
  
  // 玩家游戏状态
  players: [
    {
      userId: "xxx",
      seatNumber: 1,
      role: "witch",
      faction: "good",
      alive: true,
      lives: 1,                       // 深度模式：剩余命数
      items: [
        { type: "moonstone", value: 2, revealed: false },
        { type: "balance", value: "balanced", revealed: true }  // 已公开
      ],
      // 角色特定状态
      roleState: {
        antidoteUsed: false,           // 女巫解药
        poisonUsed: true,              // 女巫毒药
        // 守卫：lastGuardTarget
        // 白痴：immunityUsed
        // 骑士：duelUsed
        // 猎人：canShoot (被毒死时为 false)
      }
    }
  ],

  // 夜晚行动收集（当前夜晚）
  nightActions: {
    guard: { target: userId },
    wolves: { target: userId, votes: { wolfUserId: targetUserId } },
    witch: { action: "none" | "antidote" | "poison", target: userId },
    seer: { target: userId },
    gravedigger: { target: userId }
  },

  // 标记发言进度
  markingOrder: [userId, ...],         // 发言顺序
  markingCurrent: 2,                   // 当前发言者索引
  
  // 历史记录
  history: {
    rounds: [],
    marks: [],
    votes: []
  }
}
```

### 5.2 状态推送原则

**服务端只推送该玩家有权看到的信息**，绝不发送完整 gameState。

| 信息 | 可见范围 |
|------|---------|
| 自己的角色和物品类型 | 仅自己 |
| 狼人队友 | 仅狼人阵营 |
| 查验结果 | 仅预言家/守墓人自己 |
| 被刀者信息 | 仅女巫（夜晚操作时） |
| 标记内容 | 公开后全体可见 |
| 投票记录 | 投票结束后全体可见 |
| 遗物内容 | 公开后全体可见 |
| 存活状态 | 全体可见 |

### 5.3 客户端状态

前端维护的本地状态（来源全部是服务端推送，**不做任何游戏逻辑判定**）：

```javascript
{
  // 自己的私有信息
  myRole: "witch",
  myFaction: "good",
  myItems: ["moonstone"],
  myTeammates: [],                     // 狼人才有值
  
  // 公开信息
  players: [ /* 座位、昵称、存活状态 */ ],
  phase: "day_marking",
  round: 2,
  
  // 当前阶段相关
  currentAction: null,                 // 轮到自己操作时的操作类型
  
  // 历史数据
  marks: [],                           // 所有已公开的标记
  votes: [],                           // 所有已公开的投票
  relics: [],                          // 所有已公开的遗物
  announcements: []                    // 系统公告（死讯等）
}
```

---

## 六、Socket.IO 事件清单

### 6.1 连接

| 事件方向 | 事件名 | 说明 |
|----------|--------|------|
| 握手参数 | — | `{ userId, nickname }` 在连接时携带 |
| S→C | `server:connected` | 连接成功，返回用户状态（是否在房间中） |
| S→C | `server:reconnected` | 重连成功，返回当前游戏完整状态 |

### 6.2 房间

| 事件方向 | 事件名 | 说明 |
|----------|--------|------|
| C→S | `room:create` | 创建房间 |
| C→S | `room:join` | 加入房间 |
| C→S | `room:leave` | 离开房间 |
| C→S | `room:kick` | 踢出玩家（房主） |
| C→S | `room:updateSettings` | 修改房间设置（房主） |
| C→S | `room:startGame` | 开始游戏（房主） |
| S→C | `server:roomUpdate` | 房间信息更新 |
| S→C | `server:playerJoined` | 新玩家加入 |
| S→C | `server:playerLeft` | 玩家离开 |
| S→C | `server:kicked` | 被踢出 |

### 6.3 游戏

| 事件方向 | 事件名 | 说明 |
|----------|--------|------|
| S→C | `server:gameStart` | 游戏开始，推送身份 |
| S→C | `server:phaseChange` | 阶段切换 |
| S→C | `server:nightAction` | 通知角色进行夜晚操作 |
| S→C | `server:witchInfo` | 女巫专用：告知被刀者 |
| S→C | `server:investigateResult` | 预言家/守墓人查验结果 |
| S→C | `server:dayAnnouncement` | 白天公告（死讯+遗物） |
| S→C | `server:hunterTrigger` | 猎人开枪触发 |
| S→C | `server:hunterResult` | 猎人开枪结果 |
| S→C | `server:knightTurn` | 骑士决斗回合 |
| S→C | `server:duelResult` | 决斗结果 |
| S→C | `server:markingTurn` | 轮到某玩家标记发言 |
| S→C | `server:marksRevealed` | 标记公开 |
| S→C | `server:votingStart` | 投票开始 |
| S→C | `server:votingResult` | 投票结果 |
| S→C | `server:foolImmunity` | 白痴免疫触发 |
| S→C | `server:wolfKingTrigger` | 白狼王带人触发 |
| S→C | `server:wolfKingResult` | 白狼王带人结果 |
| S→C | `server:gameOver` | 游戏结束 |
| C→S | `client:nightAction` | 提交夜晚操作 |
| C→S | `client:submitMarks` | 提交标记 |
| C→S | `client:vote` | 提交投票 |
| C→S | `client:hunterAction` | 猎人操作 |
| C→S | `client:knightAction` | 骑士操作 |
| C→S | `client:wolfKingAction` | 白狼王操作 |

---

## 七、前端页面与路由

### 7.1 路由设计

| 路由 | 页面 | 说明 |
|------|------|------|
| `/` | 首页 | 输入昵称、创建/加入房间 |
| `/room/:roomId` | 房间页 | 等候大厅 + 游戏主界面（同一路由，按状态切换） |

首版仅 2 个路由，保持简洁。

### 7.2 首页

- 昵称输入框（自动填充 localStorage 中的昵称）
- 「创建房间」按钮 → 弹出配置面板（选模板/自定义）→ 创建后跳转房间页
- 「加入房间」输入框 → 输入 6 位房间号 → 加入后跳转房间页

### 7.3 房间页 — 等候大厅

- 显示房间号（可复制）
- 玩家列表（头像占位 + 昵称 + 座位号）
- 房间配置展示（角色配置、物品设置、计时器等）
- 房主额外显示：修改配置、踢人、开始游戏按钮
- 人数不足时「开始游戏」按钮置灰

### 7.4 房间页 — 游戏主界面

#### 布局

```
┌─────────────────────────────────┐
│           玩家席位环             │  ← 环形排列所有玩家
│       （中间显示阶段信息）        │
├─────────────────────────────────┤
│           信息面板               │  ← 系统公告、标记历史、遗物记录
├─────────────────────────────────┤
│           操作区                 │  ← 当前阶段的操作界面
└─────────────────────────────────┘
```

#### 玩家席位环

- 所有玩家环形排列，自己固定在底部中央
- 每个席位显示：昵称、座位号、存活状态、濒死标记（深度模式）
- 出局玩家灰色处理，显示已公开的遗物图标
- 翻开的白痴显示特殊标识

#### 信息面板

- Tab 切换：系统公告 / 标记历史 / 投票记录 / 遗物列表
- 标记历史支持按轮次筛选
- 遗物列表显示所有已公开遗物的类型和内容

#### 操作区（按阶段动态切换）

| 阶段 | 操作区内容 |
|------|-----------|
| 夜晚（轮到自己） | 技能操作面板（选目标、确认） |
| 夜晚（等待） | "夜晚进行中…"等待提示 |
| 标记发言（轮到自己） | 身份声明选择 + 评价标记选择 |
| 标记发言（等待） | 观看其他玩家的标记展示 |
| 投票 | 投票面板（选一人、确认） |
| 特殊触发 | 对应操作面板（开枪/带人/决斗） |
| 游戏结束 | 结算展示 |

### 7.5 游戏结算页

- 胜利/失败动画
- 所有玩家身份揭晓
- 完整对局回顾（标记 + 投票时间线）
- 「再来一局」按钮（房主可见）→ 回到等候大厅

---

## 八、错误处理

### 8.1 错误码

| 错误码 | 说明 |
|--------|------|
| `ROOM_NOT_FOUND` | 房间不存在 |
| `ROOM_FULL` | 房间已满 |
| `GAME_IN_PROGRESS` | 游戏进行中，不可加入 |
| `NICKNAME_TAKEN` | 昵称已被使用 |
| `NOT_HOST` | 非房主，无权操作 |
| `INVALID_CONFIG` | 配置不合法 |
| `NOT_YOUR_TURN` | 不是你的操作回合 |
| `INVALID_ACTION` | 非法操作（如投票给自己） |
| `TIMEOUT` | 操作超时 |
| `PLAYER_NOT_FOUND` | 目标玩家不存在 |

### 8.2 前端错误提示

- Socket 断线：顶部显示"连接已断开，正在重连…"
- 操作失败：Toast 提示错误信息
- 页面刷新：自动重连并恢复状态

---

## 九、首版范围与后续规划

### 9.1 首版功能（MVP）

- [x] 游客模式（UUID + 昵称）
- [ ] 房间创建/加入/离开
- [ ] 预设模板选择（优先实现 4 人局、6 人局）
- [ ] 完整游戏流程（夜晚 → 白天 → 投票 → 循环）
- [ ] 标记系统（身份声明 + 评价标记 + 理由）
- [ ] 基础角色：狼人、预言家、女巫、守卫、平民
- [ ] 物品系统（月光石 + 天平徽章）
- [ ] 掉线重连
- [ ] 游戏结算展示

### 9.2 次版功能

- [ ] 扩展角色：猎人、白狼王、白痴、骑士、守墓人
- [ ] 猎犬哨（大局物品）
- [ ] 4 人局深度模式（两条命 + 双遗物）
- [ ] 自定义角色配置
- [ ] 遗言功能

### 9.3 远期规划

- [ ] 账号系统（注册/登录）
- [ ] 战绩统计
- [ ] AI NPC 玩家（规则型 → 大模型型）
- [ ] 警长系统
- [ ] 更多物品类型
- [ ] 移动端适配优化
