# Pendle plugin — Boros maker-reward findings (2026-08-24 probe)

## Reward structure (from /v1/incentives/maker-incentives/campaigns/{marketId})

Three independent streams per market:

1. **addLiquidityIncentive** — the one we farm. PER SIDE (long/short each has
   its own budget and pool):
   - `incentiveRange` — the in-range band, e.g. 0.00375 = ±0.375% (implied APR
     terms). Varies per market: ±0.375% (majors, 31d) → ±8.75% (BRENTOIL).
   - `budgetPerHour` — hourly reward budget for that side (PENDLE).
   - `currentInRangeLiquidity` — the pool you share against (YU, 1e18-scaled,
     collateral-token units — NOT comparable across tokenIds without pricing).
   - Your reward/h = budgetPerHour × yourInRange / (pool + yourInRange).
   - **NO distance weighting** — edge of band earns the same as at mid.
     => posture A (rest at the far edge, track the band) is CONFIRMED viable.
2. **filledVolumeIncentive** — pro-rata to filled maker volume per epoch
   (all zero right now).
3. **makerFeeRebate** — feeShareRate 0.2 (20% of taker fees you're matched
   against).

Both sides carry separate budgets → double-sided resting earns both. Sample
scan (2026-08-24): ~30 live markets; several with tiny pools and real budgets
(e.g. OKX-BTCUSDT-25SEP2026: L pool ≈ 10 YU @ 0.38 PENDLE/h; BINANCE-BTCUSDT
25SEP: S pool ≈ 7.5 YU @ 0.81 PENDLE/h) — small size captures a large share.

## SDK facts (@pendle/boros-sdk-public 0.3.1)

- `Exchange(walletClient, root, accountId, [rpc], agent)` — trading surface:
  placeOrder / bulkPlaceOrders / cancelOrders / bulkCancelOrders /
  bulkSignAndExecute (mixed batch — likely cancel+place in one dispatch),
  enterMarkets, deposit/withdraw, **getGasBalance** (the gas-floor alert),
  approveAgent, getOrderBook/getMarketData/getAllMarkets/getUserPositions.
- `Agent.create()` / `Agent.createFromPrivateKey(pk)`; approve once with the
  root wallet; trading then only needs the agent key (Send Txs Bot relays,
  gas debited from the account's USD gas balance).
- Public data needs NO auth: `getOpenApiSdk()` — markets
  (isMatured:false, limit, resumeToken pagination), orderbook
  (tickSize ∈ {0.0001,0.001,0.01,0.1}), OHLCV, indicators, campaigns.
- Read-API auth for account routes: Ed25519 API signing key (ApiKeys.asAgent
  can mint it — root key stays cold).
- viem pinned 2.55.10 inside the SDK — keep our range compatible.
- Market list: page with isMatured:false or the first page is all expired.

## Scripts

- `scripts/probe.ts` — markets + campaign + orderbook smoke.
- `scripts/scan-incentives.ts` — live budget scan across unexpired markets.

## Next (needs the user's key — do NOT run unattended)

1. setup-agent script: Agent.create() → root approveAgent → store
   'boros/agent' credential via gateway.
2. Credentialed smoke: enterMarkets, place 1 far-edge order, cancel it,
   read getGasBalance.
