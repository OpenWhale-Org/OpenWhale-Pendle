# openwhale-pendle-maker

Boros maker-reward strategy for [OpenWhale](https://github.com/openwhaleorg/openwhale). One instance quotes one Boros market: it rests a post-only order at the far edge of each side's maker-incentive band, follows the band as the mid implied APR moves, and earns the campaign's hourly budget in proportion to its share of in-band liquidity.

Depends on the `pendle` venue plugin (`@jarei/openwhale-pendle`) for the Boros agent credential, the `pendle/rates` account and the trading session.

[中文说明 →](./README.zh-CN.md)

## How it works

- **Band.** Each market side (long / short) may run a maker-incentive campaign: an hourly budget paid to orders resting within `±range` of the mid implied APR. Distance does not matter — every YU in band earns the same.
- **Corridor.** The strategy rests at `edgeRatio × range` from mid (the far edge — least fill risk, same reward). It leaves the order alone while its distance to mid stays inside `[safeDistanceRatio × range, range]`, and re-quotes only when the order drifts out of the band or mid comes too close.
- **One transaction per tick.** All cancels and places of a tick go out as a single relayed Arbitrum transaction (`requote`), paid from the account's USD gas balance — about $0.01–0.02 per re-quote.
- **Accidents.** A fill is not a goal. When the position deviates from the baseline, the deviation is flattened at once with an IOC and quoting resumes.
- **Baseline.** At activation the strategy snapshots what the account already holds on the market (position + resting orders) and never touches it. Run on a dedicated sub-account when you can.

At steady state the strategy holds at most one order per side: **two orders in `both` mode, one in `long` / `short` mode** — plus whatever the baseline holds.

## Setup

1. Create a **Boros Agent** credential in the pendle plugin (root address + agent key + sub-account id) and a `pendle/rates` account on it.
2. Deposit collateral into the market you want to quote and top up the account's **gas balance** (Boros UI → Gas). Deposits are never automated.
3. Run the pendle plugin's **Scan maker incentives** script to find a market with a live budget and a small pool.
4. Create a strategy instance, pick the market, leave **Dry run** on, watch the logs, then switch it off.

## Strategy parameters

### Base

| Param | Default | Meaning |
|---|---|---|
| `market` | — | The Boros market this instance quotes (picked from the venue catalogue). One instance = one market. |
| `dryRun` | `true` | Follow the band and log every cancel/place that *would* be sent, without sending. Switch off explicitly to go live. |
| `marginMode` | `auto` | Which margin account the orders live in. `auto` = isolated when the venue marks the market isolated-only, else cross. Reads, cancels and the baseline snapshot are scoped to this account. |
| `baselineSnapshot` | `true` | Record the position and resting orders the account already holds at activation and never touch them. Best effort — a manual trade *after* activation looks like a fill and gets flattened. Off = everything on the market is treated as the strategy's own. |

### Size

| Param | Default | Meaning |
|---|---|---|
| `sizeYu` | `10` | Order size per side in YU (1 YU = 1 unit of the collateral token of funding notional). Reward share per side = `sizeYu / (pool + sizeYu)`. |
| `sides` | `both` | `both` rests one order per side; `long` / `short` only that side. Each side has its own budget and pool. |

### Corridor

| Param | Default | Meaning |
|---|---|---|
| `edgeRatio` | `0.95` | Resting distance from mid as a fraction of the band half-width. `0.95` = just inside the far edge (protects against rounding). |
| `safeDistanceRatio` | `0.3` | Inner line. When mid comes closer than this fraction of the half-width, the order is re-quoted back to the edge — fill risk rises fast near the touch. |
| `requoteIntervalMs` | `30000` | Minimum time between emissions per side, for placing *and* re-quoting. The contract read lags the relay by a few seconds; below ~15 s a fresh order can be placed twice. |

### Risk

| Param | Default | Meaning |
|---|---|---|
| `gasFloorUsd` | `3` | Relayed actions are paid from the account's on-chain USD gas balance. Below this, quoting pauses (an empty balance fails silently on the venue). |
| `flattenSlippage` | `0.02` | After an accidental fill, how far past the touch the flatten IOC may reach, as a fraction of APR. |

## Executor actions (`pendle-maker/maker`)

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
| `flatten` | `baselineSizeYu`, `slippage` | Cancel own orders and IOC the position back to `baselineSizeYu`. |
| `simulate*` | same | Log the exact venue call without sending — what dry run uses. |

`apr` is a decimal implied APR (`0.068` = 6.8 %, negatives are allowed). `sizeYu` is in YU.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test        # corridor unit tests
pnpm build       # dist/ — what the OpenWhale dashboard installs
```
