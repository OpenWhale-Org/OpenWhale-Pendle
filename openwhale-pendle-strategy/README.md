# OpenWhale Pendle Strategy

An open-source collection of trading strategies for [Pendle](https://www.pendle.finance) — Pendle V2 (PT/YT markets) and Boros (interest-rate swaps) — built on the [OpenWhale](https://github.com/OpenWhale-Org/OpenWhale) framework. Each strategy is a plugin component: install the package into a running gateway, create an instance from the Dashboard, and the framework handles scheduling, accounts, execution and observability.

Published as `@openwhaleorg/pendle-strategy`. Depends on the [`@openwhaleorg/pendle`](../openwhale-pendle) venue plugin (credentials, accounts, trading sessions) and `@openwhaleorg/core`.

[中文说明 →](./README.zh-CN.md)

## Strategies

| Strategy | Product | Status | Summary |
|---|---|---|---|
| [Boros Maker Rewards](#1-boros-maker-rewards) | Boros | **Live** | Rests post-only orders at the far edge of a market's maker-incentive band and follows the band; earns the hourly budget in proportion to in-band liquidity |
| Boros funding-rate basis | Boros | Planned | Fixed-vs-floating funding carry across Boros and a perp venue |
| Pendle PT/YT yield rotation | Pendle V2 | Planned | Rotate between PT and YT on implied-vs-realised yield |
| Pendle LP incentive farming | Pendle V2 | Planned | LP where incentives beat impermanent-yield risk |

Planned entries are direction, not commitment — open an issue to discuss one.

## Install

1. From the Dashboard's **Plugins** page install `@openwhaleorg/pendle` first, then `@openwhaleorg/pendle-strategy` (by npm name, or by the absolute path of a local checkout).
2. Create the credentials and accounts the strategy needs (see each strategy's setup below).
3. **Strategies → New strategy**, pick the strategy, fill its parameters, activate.

## Develop

```sh
pnpm install     # from the workspace root — links @openwhaleorg/core from a sibling OpenWhale checkout
pnpm build
pnpm test
```

Source is English-only; this README has a Chinese twin. Contributions follow the OpenWhale plugin conventions (`skills/openwhale-dev` in the framework repository).

---

## 1. Boros Maker Rewards

`pendle-strategy/boros-maker` · monitor `pendle-strategy/market-watch` · executor `pendle-strategy/maker`

One instance quotes one Boros market: it rests a post-only order at the far edge of each side's maker-incentive band, follows the band as the mid implied APR moves, and earns the campaign's hourly budget in proportion to its share of in-band liquidity.

### How it works

- **Band.** Each market side (long / short) may run a maker-incentive campaign: an hourly budget paid to orders resting within `±range` of the mid implied APR. Distance does not matter — every YU in band earns the same.
- **Corridor.** The strategy rests at `edgeRatio × range` from mid (the far edge — least fill risk, same reward). It leaves the order alone while its distance to mid stays inside `[safeDistanceRatio × range, range]`, and re-quotes only when the order drifts out of the band or mid comes too close.
- **One transaction per tick.** All cancels and places of a tick go out as a single relayed Arbitrum transaction (`requote`), paid from the account's USD gas balance — about $0.01–0.02 per re-quote.
- **Size.** Fixed, or a percentage of what the account's margin can currently open — recomputed every tick, so the size follows the balance instead of a number typed once. See [Sizing](#sizing).
- **Accidents.** A fill is not a goal. The venue is asked what closing would actually cost, and that answer decides whether to cross now or wait. No new edge orders go out until the position is flat. See [After a fill](#after-a-fill).
- **Baseline.** At activation the strategy snapshots what the account already holds on the market (position + resting orders) and never touches it. Run on a dedicated sub-account when you can.

At steady state the strategy holds at most one order per side: **two orders in `both` mode, one in `long` / `short` mode** — plus whatever the baseline holds.

### Setup

1. Create a **Boros Agent** credential in the pendle plugin (root address + agent key + sub-account id) and a `pendle/rates` account on it.
2. Deposit collateral into the market you want to quote and top up the account's **gas balance** (Boros UI → Gas). Deposits are never automated.
3. Run the pendle plugin's **Scan maker incentives** script to find a market with a live budget and a small pool.
4. Create a strategy instance, pick the market, leave **Dry run** on, watch the logs, then switch it off.

### Strategy parameters

#### Base

| Param | Default | Meaning |
|---|---|---|
| `market` | — | The Boros market this instance quotes (picked from the venue catalogue). One instance = one market. |
| `dryRun` | `true` | Follow the band and log every cancel/place that *would* be sent, without sending. Switch off explicitly to go live. |
| `marginMode` | `auto` | Which margin account the orders live in. `auto` = isolated when the venue marks the market isolated-only, else cross. Reads, cancels and the baseline snapshot are scoped to this account. |
| `baselineSnapshot` | `true` | Record the position and resting orders the account already holds at activation and never touch them. Best effort — a manual trade *after* activation looks like a fill and gets flattened. Off = everything on the market is treated as the strategy's own. |

#### Size

| Param | Default | Meaning |
|---|---|---|
| `sizeMode` | `fixed` | `fixed` = the same YU every time. `percent` = a share of what the margin can open right now, recomputed every tick. |
| `sizeYu` | `10` | **Fixed mode.** Order size per side in YU (1 YU = 1 unit of the collateral token of funding notional). Reward share per side = `sizeYu / (pool + sizeYu)`. |
| `sizePercent` | `75` | **Percent mode.** Share of capacity, applied *per side* rather than split between them. |
| `resizeTolerance` | `0.1` | **Percent mode.** Re-quote when the target drifts this far from what is resting. |
| `sides` | `both` | `both` rests one order per side; `long` / `short` only that side. Each side has its own budget and pool. |

##### Sizing

Percent mode computes, per side and per tick:

```
capacity = this margin account's equity ÷ margin the venue asks per YU at the resting rate
free     = capacity − whatever the baseline already occupies
size     = free × sizePercent
```

The margin figure is the account's **equity**, not its free margin. Free margin nets out the orders the strategy itself has resting, so sizing against it shrinks the target every time it is met — 750 YU resting, 187 the next tick, 608 the one after, for ever, paying a relayed transaction on every swing. Equity does not move when we quote against it.

The baseline is subtracted because it is untouchable: its position and orders hold margin the strategy may never reclaim, and counting that as capacity produces orders the venue then rejects.

`sizePercent` applies to **each side**, not split between them — on a rate market a long and a short largely offset, so `75` means 75 % on each. Every input to the number is logged; if a venue ever stops netting the two, the second side is what gets rejected.

`resizeTolerance` is not a nicety. Capacity moves with every mark-to-market tick and each re-quote is a relayed transaction that costs gas; without a threshold the strategy spends the day paying to chase noise.

> **Percent mode needs a dedicated sub-account.** Baseline detection recognises the strategy's own leftovers after a restart by their exact size — a signature percent mode cannot have, since the size was whatever the balance allowed at the time. Band position is what remains, and it is weaker: a hand-placed order resting in the band will be adopted and re-quoted away.

#### Corridor

| Param | Default | Meaning |
|---|---|---|
| `edgeRatio` | `0.95` | Resting distance from mid as a fraction of the band half-width. `0.95` = just inside the far edge (protects against rounding). |
| `safeDistanceRatio` | `0.3` | Inner line. When mid comes closer than this fraction of the half-width, the order is re-quoted back to the edge — fill risk rises fast near the touch. |
| `requoteIntervalMs` | `30000` | Minimum time between emissions per side, for placing *and* re-quoting. The contract read lags the relay by a few seconds; below ~15 s a fresh order can be placed twice. |

#### Risk

| Param | Default | Meaning |
|---|---|---|
| `gasFloorUsd` | `3` | Relayed actions are paid from the account's on-chain USD gas balance. Below this, quoting pauses (an empty balance fails silently on the venue). |
| `flattenSlippage` | `0.02` | The limit on the closing IOC itself — how far past the touch it may reach before giving up. Not the decision of whether to cross; that is Fill. |

#### Fill

| Param | Default | Meaning |
|---|---|---|
| `fillSlippage` | `0.005` | Cross straight away when the simulated close lands within this of the touch. `0` = always cross, whatever it costs. |
| `fillPolicy` | `limit` | What to do when it does not: `limit`, `partial`, `ladder`, `hold`. |
| `fillTimeoutMs` | `600000` | Cross regardless once the position has been open this long. `0` = never. |
| `fillStopDistance` | `0.15` | Cross regardless once mid has moved this far against the position, as a fraction of the entry rate. `0` = off. **Synthetic** — see below. |
| `fillSlices` | `4` | Ladder policy only. |
| `fillSliceIntervalMs` | `60000` | Ladder policy only. |

##### After a fill

A maker-reward strategy wants no position, so a fill is damage — and getting flat is a choice between two costs. Crossing pays the spread plus whatever depth the book lacks, and pays it now. Resting pays nothing but has no deadline, and every second the rate is free to move further away.

Which is why the immediate IOC was the wrong default for the commonest case: an order at the band edge is usually taken *because the market moved to it*, so crossing straight back realises the spread and the taker fee on an adverse move.

So the venue simulates the whole close against the resting book and answers with the average rate it would actually get — not the spread, which is only what the first YU pays. That number, against `fillSlippage`, decides:

| Policy | Above budget it… |
|---|---|
| `limit` | rests a post-only close at the touch and waits |
| `partial` | crosses the size the book absorbs within budget, rests the remainder |
| `ladder` | crosses one slice per interval, resting between them |
| `hold` | keeps the position and cancels our orders |

Measured against the **touch**, never the entry. The entry is sunk and says nothing about whether crossing now is expensive; deciding from it produces the exact wrong reflex — the further underwater, the more reluctant to close.

Two overrides sit above every policy, because "wait for a better price" is a plan with no end: `fillTimeoutMs` and `fillStopDistance`. They fire even when the venue will not price the close, because a book too broken to quote is when a stop matters most. Without an override, an unpriceable close rests rather than crossing blind.

**The stop is synthetic.** Boros has no conditional orders — its `TimeInForce` set is GTC / IOC / FOK / ALO only — so the strategy watches the rate and fires the IOC itself. It protects while the engine is running, reacts no faster than one tick, and does not protect through a restart. Better than nothing, and not what a venue stop would be.

While any of this is going on the strategy places **no new edge orders**: the band edge is where fills come from, and adding more while already holding inventory is how one bad tick becomes a position. `hold` cancels ours too — not closing is not the same as leaving orders resting.

The ladder slices the size at *detection* rather than the remainder, or it is Zeno's ladder: every step smaller than the last, arriving never. Each slice is its own relayed transaction with its own gas — split finer than the spread being saved and the ladder costs more than crossing once.

### Executor actions (`pendle-strategy/maker`)

Everything the strategy does goes through this executor; the dashboard's **Manual fire** exposes the same actions. Common fields:

| Field | Meaning |
|---|---|
| `marketId` | Venue market id (integer, e.g. `189`). |
| `tokenId` | Collateral token id of the market — together with the root and sub-account it forms the `MarketAcc` the venue addresses. |
| `marginMode` | `cross` or `isolated` — the margin account the order lives in. Must match the market (isolated-only markets refuse `cross`). |
| `protectOrderIds` | Order ids that must never be cancelled (the baseline). Empty when firing by hand. |

| Action | Fields | What it does |
|---|---|---|
| `requote` | `orders[] {side, sizeYu, apr}`, `cancelSides[]` | **One transaction:** cancels every non-protected order on each touched side, then rests the new orders. The strategy's tick. |
| `quote` | `side`, `sizeYu`, `apr` | Single-side convenience form of `requote`. |
| `cancel` | `side?`, `orderIds?` | Cancel non-protected orders on a side (or both sides); `orderIds` narrows to specific ids. |
| `flatten` | `baselineSizeYu`, `slippage`, `how`, `maxSizeYu?` | Move the position back toward `baselineSizeYu`. `how: 'ioc'` crosses; `how: 'limit'` rests a post-only close at the touch (idempotent — an existing close of the right side and size is left to keep its queue position). `maxSizeYu` caps the slice. The size is re-read from the venue, not taken from the caller: a partial fill landing between decision and execution is how a flatten overshoots into a position facing the other way. |
| `simulate*` | same | Log the exact venue call without sending — what dry run uses. |

`apr` is a decimal implied APR (`0.068` = 6.8 %, negatives are allowed). `sizeYu` is in YU.
