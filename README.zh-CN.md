# OpenWhale Pendle Strategy（中文说明）

OpenWhale 的 Boros 挂单奖励策略。一个实例只做一个 Boros 市场：在每一侧激励带的最远边缘挂一张 post-only 单，随中间隐含 APR 的移动跟着带走，按自己在带内流动性中的份额领取该侧的每小时预算。

依赖 `pendle` 场地插件（`@jarei/openwhale-pendle`）：Boros Agent 凭证、`pendle/rates` 账户、交易会话。

## 工作原理

- **激励带。** 每个市场的每一侧（long / short）可能有一个 maker 激励活动：每小时的预算发给挂在中间 APR `±range` 范围内的订单。距离不加权 —— 带内每一 YU 拿到的一样多。
- **走廊。** 策略挂在离 mid `edgeRatio × range` 的位置（最远边缘：成交风险最低，奖励一样）。只要订单到 mid 的距离还在 `[safeDistanceRatio × range, range]` 内就不动它；只有订单漂出带外、或 mid 逼近到安全线以内时才重挂。
- **每 tick 一笔交易。** 一个 tick 里所有的撤单和挂单打包成一笔 Arbitrum 中继交易（`requote`），从账户的 USD gas 余额扣费，一次重挂约 $0.01–0.02。
- **意外成交。** 成交不是目标。仓位一旦偏离基线，立刻用 IOC 把偏离量平掉，然后继续挂单。
- **基线。** 激活时快照账户在该市场已有的仓位和挂单，之后绝不碰它们。有条件就用独立子账户跑。

稳态下每侧最多一张单：**`both` 模式 2 张，`long` / `short` 模式 1 张** —— 基线里的不算。

## 准备

1. 在 pendle 插件里创建 **Boros Agent** 凭证（root 地址 + agent 私钥 + 子账户 id），再基于它建一个 `pendle/rates` 账户。
2. 把保证金充进要做的市场，并给账户的 **gas 余额** 充值（Boros UI → Gas）。充值永远不自动化。
3. 跑 pendle 插件的 **Scan maker incentives** 脚本，挑一个预算在线、池子小的市场。
4. 创建策略实例、选市场，先保持 **Dry run** 开着看日志，确认后再关掉。

## 策略参数

### 基础

| 参数 | 默认 | 含义 |
|---|---|---|
| `market` | — | 本实例要做的 Boros 市场（从场地目录里选）。一实例一市场。 |
| `dryRun` | `true` | 跟随激励带并记录每一次「本来会发的」撤单/挂单，但不发送。要实盘必须手动关掉。 |
| `marginMode` | `auto` | 订单放在哪个保证金账户。`auto`：市场被标记为仅逐仓时用 isolated，否则 cross。读取、撤单、基线快照都限定在这个账户。 |
| `baselineSnapshot` | `true` | 激活时记录账户在该市场已有的仓位和挂单，之后不碰它们。尽力而为 —— 激活之后手动下的单会被当成意外成交而平掉。关掉 = 市场上的一切都视为策略自己的。 |

### 规模

| 参数 | 默认 | 含义 |
|---|---|---|
| `sizeYu` | `10` | 每侧挂单量（YU；1 YU = 1 单位抵押币的资金费名义）。每侧奖励份额 = `sizeYu / (池子 + sizeYu)`。 |
| `sides` | `both` | `both` 每侧一张；`long` / `short` 只做一侧。每侧有各自的预算和池子。 |

### 走廊

| 参数 | 默认 | 含义 |
|---|---|---|
| `edgeRatio` | `0.95` | 挂单离 mid 的距离，占带宽一半的比例。`0.95` = 刚好在最远边缘内侧（防舍入出带）。 |
| `safeDistanceRatio` | `0.3` | 内线。mid 逼近到不足这个比例的半带宽时，把单重挂回边缘 —— 越靠近盘口成交风险越高。 |
| `requoteIntervalMs` | `30000` | 每侧两次发单的最小间隔，挂单和重挂都受限。合约读数比中继滞后几秒，低于 ~15 s 可能把刚挂的单再挂一次。 |

### 风控

| 参数 | 默认 | 含义 |
|---|---|---|
| `gasFloorUsd` | `3` | 中继动作从账户链上的 USD gas 余额扣费。低于此值暂停挂单（余额耗尽时场地会静默失败）。 |
| `flattenSlippage` | `0.02` | 意外成交后，平仓 IOC 可以越过盘口多远，按 APR 比例。 |

## 执行器动作（`pendle-strategy/maker`）

策略的所有动作都走这个执行器；看板的 **Manual fire** 暴露同一组动作。公共字段：

| 字段 | 含义 |
|---|---|
| `marketId` | 场地市场 id（整数，如 `189`）。 |
| `tokenId` | 市场的抵押币 id —— 和 root、子账户一起组成场地寻址用的 `MarketAcc`。 |
| `marginMode` | `cross` 或 `isolated`，订单所在的保证金账户。必须和市场匹配（仅逐仓市场拒绝 `cross`）。 |
| `protectOrderIds` | 绝不能撤的订单 id（基线）。手动触发时留空。 |

| 动作 | 字段 | 作用 |
|---|---|---|
| `requote` | `orders[] {side, sizeYu, apr}`, `cancelSides[]` | **一笔交易：** 先撤掉被触及的每一侧上所有非保护订单，再挂新单。策略每个 tick 用的就是它。 |
| `quote` | `side`, `sizeYu`, `apr` | `requote` 的单侧简写。 |
| `cancel` | `side?`, `orderIds?` | 撤某一侧（或双侧）的非保护订单；`orderIds` 可限定到具体 id。 |
| `flatten` | `baselineSizeYu`, `slippage` | 撤掉自己的单，用 IOC 把仓位平回 `baselineSizeYu`。 |
| `simulate*` | 同上 | 只记录将要发出的场地调用，不发送 —— Dry run 用的就是这些。 |

`apr` 是十进制隐含 APR（`0.068` = 6.8 %，允许负数）。`sizeYu` 单位为 YU。
