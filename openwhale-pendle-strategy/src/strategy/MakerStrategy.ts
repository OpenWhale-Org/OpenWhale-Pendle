import { z } from 'zod'
import { BaseStrategy, createLogger } from '@openwhaleorg/core'
import type { ExecutionInstruction, StrategyContext, StrategyParams, Trigger, StrategyDeclarations, MonitorSource } from '@openwhaleorg/core'
import { BorosRatesAccount } from '@openwhaleorg/pendle'
import type { BorosSide, BorosMarginMode } from '@openwhaleorg/pendle'
import type { MarketWatchSample } from '../monitor/MarketWatchMonitor.js'
import { judgeSide } from './corridor.js'
import { makerIllustrations } from './paramsIllustrations.js'

const log = createLogger('BorosMaker')

/**
 * Boros maker-reward strategy — one instance = one market (design S5).
 *
 * Posture A (S1): rest post-only orders at the far edge of the maker
 * incentive band on both sides (S2) and follow the band as mid moves,
 * re-quoting only when an order leaves the corridor [safe, edge] (S3).
 * Reward is the campaign's hourly budget × our share of in-band liquidity —
 * with no distance weighting, the edge earns what the touch earns at a
 * fraction of the fill risk. A fill is an accident: the position is
 * flattened immediately with an IOC and quoting resumes.
 *
 * Deposits are manual (S5): if the venue rejects for margin, this logs and
 * waits. The account's USD gas balance funds every relayed action — below
 * the floor, quoting pauses rather than failing silently.
 *
 * Baseline: the account may already hold a position and resting orders when
 * the instance starts. At every activation the strategy snapshots what the
 * cross account holds on the market — position size and order ids — and
 * treats it as untouchable: it only ADDS orders, never cancels baseline
 * ones, and flattens only deviations from the baseline size. The venue does
 * not isolate the account, so the baseline is best effort (a manual trade
 * after activation looks like a fill) — run the strategy on its own
 * sub-account when you can.
 */

const decls = {
  monitors: [{ name: 'pendle-strategy/market-watch', label: 'watch' }],
  executors: [{ name: 'pendle-strategy/maker', label: 'maker' }],
  accounts: [{ account: BorosRatesAccount, label: 'boros' }],
} as const satisfies StrategyDeclarations

interface SideState {
  /** Last APR we asked the executor to rest at. */
  apr: number
  ts: number
}

interface Baseline {
  signedSizeYu: number
  orderIds: string[]
  takenAt: number
}

interface MakerState {
  long?: SideState
  short?: SideState
  /** What the cross account held at the last activation — never touched. */
  baseline?: Baseline
  /** Last flatten emission — one accident, one flatten. */
  lastFlattenTs?: number
  /** Gas-floor pause announced (so the log isn't spammed every tick). */
  gasPaused?: boolean
}

const STATE_KEY = 'maker'

export class MakerStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'boros-maker'

  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly accounts = decls.accounts
  readonly paramsIllustrations = makerIllustrations

  readonly baseParamsSchema = z.object({
    market: z.string().min(3).meta({
      displayName: 'Boros market',
      description: 'One instance quotes one market. Pick from the venue\'s live markets; run pendle/scan-incentives to see which have a budget and a small pool.',
      catalogue: { source: 'market', kind: 'pendle/rates' },
    }),
    dryRun: z.boolean().default(true).meta({
      displayName: 'Dry run',
      description: 'Follows the band and logs every cancel/place it would send, without sending. Switch off explicitly to go live.',
    }),
    marginMode: z.enum(['auto', 'cross', 'isolated']).default('auto').meta({
      displayName: 'Margin mode',
      description: 'Which margin account the orders live in. auto = isolated when the venue marks the market isolated-only, else cross. The baseline snapshot and all reads/cancels are scoped to this account.',
    }),
    baselineSnapshot: z.boolean().default(true).meta({
      displayName: 'Baseline snapshot',
      description: 'On every activation, record the position and resting orders the cross account already holds on this market and never touch them: only add orders on top, flatten only deviations. Best effort — the venue does not isolate the account, so a manual trade after activation looks like a fill. Recommended: run on a dedicated sub-account. Off = everything on the market is treated as the strategy\'s own.',
    }),
  })

  readonly tunableParamsSchema = z.object({
    sizeYu: z.number().positive().default(10).meta({
      section: 'Size', displayName: 'Order size per side (YU)',
      description: '1 YU = 1 unit of the market\'s collateral token of funding notional. Reward share = sizeYu / (pool + sizeYu) per side.',
    }),
    sides: z.enum(['both', 'long', 'short']).default('both').meta({
      section: 'Size', displayName: 'Sides',
      description: 'both = double-sided (each side has its own budget and pool). Single-sided only if you have a view.',
    }),
    edgeRatio: z.number().min(0.5).max(1).default(0.95).meta({
      section: 'Corridor', displayName: 'Resting distance (× half-width)',
      description: 'Resting distance from mid as a fraction of the band half-width. 0.95 = just inside the far edge (rounding protection).',
    }),
    safeDistanceRatio: z.number().min(0.05).max(0.9).default(0.3).meta({
      section: 'Corridor', displayName: 'Safe distance (× half-width)',
      description: 'Re-quote away when mid comes closer than this fraction of the half-width — fill risk rises fast near the touch.',
    }),
    requoteIntervalMs: z.number().int().min(5_000).default(30_000).meta({
      section: 'Corridor', displayName: 'Min re-quote interval (ms)',
      description: 'Per side, for placing AND re-quoting. Every emission is one relayed transaction (cancel + place), and the contract read lags the relay by a few seconds — shorter than ~15s risks stacking a duplicate order.',
    }),
    gasFloorUsd: z.number().min(0).default(3).meta({
      section: 'Risk', displayName: 'Gas balance floor (USD)',
      description: 'Relayed actions are paid from the account\'s on-chain USD gas balance. Below this, quoting pauses (a dry balance fails silently).',
    }),
    flattenSlippage: z.number().min(0).max(0.2).default(0.02).meta({
      section: 'Risk', displayName: 'Flatten slippage (× APR)',
      description: 'How far past the touch the flatten IOC may reach after an accidental fill.',
    }),
  })

  triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    const { market } = this.baseParamsSchema.parse(params.base)
    return [
      { enabled: true, conditions: [{ type: 'monitor', sources: [{ monitorName: this.monitor('watch'), key: market }] }] },
    ]
  }

  override subscriptions(params: StrategyParams): MonitorSource[] {
    const { market } = this.baseParamsSchema.parse(params.base)
    return [{ monitorName: this.monitor('watch'), key: market }]
  }

  private evaluating = false
  /** Process-memory: a fresh strategy object per activation → the baseline is re-taken each start. */
  private baselineTaken = false

  async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
    if (this.evaluating) return []
    this.evaluating = true
    try {
      return await this.evaluateInner(context)
    } finally {
      this.evaluating = false
    }
  }

  private async evaluateInner(_context: StrategyContext): Promise<ExecutionInstruction[]> {
    const { market, dryRun, baselineSnapshot, marginMode: modeParam } = this.baseParamsSchema.parse(this.params.base)
    const t = this.tunableParamsSchema.parse(this.params.tunable)
    const act = (action: string) => (dryRun ? `simulate${action.charAt(0).toUpperCase()}${action.slice(1)}` : action)

    const record = await this.monitorData('watch')?.readLatest(market)
    const sample = record?.data as unknown as MarketWatchSample | undefined
    if (!sample) return []
    if (Date.now() - sample.ts > 120_000) {
      log.warn({ market, ageMs: Date.now() - sample.ts }, 'market-watch sample is stale — not quoting on it')
      return []
    }
    // The venue ids ride on the sample — the picker only knows the symbol
    const { marketId, tokenId } = sample
    const mode: BorosMarginMode = modeParam === 'auto' ? (sample.isolatedOnly ? 'isolated' : 'cross') : modeParam
    if (mode === 'cross' && sample.isolatedOnly) {
      log.warn({ market }, 'market is isolated-only but marginMode=cross — the venue will refuse; set marginMode to auto/isolated')
      return []
    }
    const account = this.account('boros')
    const state = (await this.store.get<MakerState>(STATE_KEY)) ?? {}
    const out: ExecutionInstruction[] = []
    const now = Date.now()

    // ── Baseline: what the account held when this activation began ──────────
    if (!this.baselineTaken) {
      const [position, resting] = await Promise.all([
        account.crossPosition(marketId, tokenId, mode).catch(() => undefined),
        account.restingOrders(marketId, tokenId, mode).catch(() => []),
      ])
      // Our own leftovers from before a restart must not become baseline, or
      // every restart stacks a fresh pair on top of the old one. An order is
      // ours when it has exactly our size and rests inside the band on its
      // side — the operator's hand-placed orders never match that signature.
      const isOurs = (o: { side: BorosSide; apr: number; sizeYu: number }) => {
        if (Math.abs(o.sizeYu - t.sizeYu) > 1e-9) return false
        const band = sample.band[o.side]
        const distance = o.side === 'long' ? sample.midApr - o.apr : o.apr - sample.midApr
        return distance >= -band.range && distance <= band.range * 1.5
      }
      const inherited = resting.filter(o => !isOurs(o))
      state.baseline = baselineSnapshot
        ? { signedSizeYu: position?.signedSizeYu ?? 0, orderIds: inherited.map(o => o.orderId), takenAt: now }
        : { signedSizeYu: 0, orderIds: [], takenAt: now }
      this.baselineTaken = true
      await this.store.set(STATE_KEY, state)
      log.info({ market, mode, baseline: state.baseline, ownLeftovers: resting.length - inherited.length, snapshot: baselineSnapshot }, 'baseline taken — untouchable from here on')
    }
    const baseline = state.baseline ?? { signedSizeYu: 0, orderIds: [], takenAt: 0 }
    const protectOrderIds = baseline.orderIds

    // ── Accident check: the cross position drifted from the baseline → one of OUR orders filled ──
    const position = await account.crossPosition(marketId, tokenId, mode).catch(() => undefined)
    const delta = (position?.signedSizeYu ?? 0) - baseline.signedSizeYu
    if (Math.abs(delta) > 1e-9) {
      if ((state.lastFlattenTs ?? 0) < now - 30_000) {
        log.warn({ marketId, deltaYu: delta, baselineYu: baseline.signedSizeYu }, 'position deviates from baseline — flattening the deviation')
        out.push(this.instruction('maker', act('flatten'), { marketId, tokenId, marginMode: mode, baselineSizeYu: baseline.signedSizeYu, protectOrderIds, slippage: t.flattenSlippage }, ['boros']))
        state.lastFlattenTs = now
        delete state.long
        delete state.short
        await this.store.set(STATE_KEY, state)
      }
      return out
    }

    // ── Fuel gauge: relayed actions die silently on an empty gas balance ────
    const gas = await account.gasBalance().catch(() => undefined)
    if (gas !== undefined && gas < t.gasFloorUsd) {
      if (!state.gasPaused) {
        log.warn({ marketId, gasUsd: gas, floor: t.gasFloorUsd }, 'gas balance below floor — quoting paused; top up the account\'s gas balance')
        state.gasPaused = true
        await this.store.set(STATE_KEY, state)
      }
      return []
    }
    if (state.gasPaused) { state.gasPaused = false; await this.store.set(STATE_KEY, state) }

    // ── Corridor per side (only OUR orders count — baseline ones are invisible here) ──
    const resting = (await account.restingOrders(marketId, tokenId, mode).catch(() => [])).filter(o => !protectOrderIds.includes(o.orderId))
    const sides: BorosSide[] = t.sides === 'both' ? ['long', 'short'] : [t.sides]
    // Everything this tick wants goes out as ONE requote instruction — the
    // executor turns it into a single relayed transaction (one gas charge).
    const orders: Array<{ side: BorosSide; sizeYu: number; apr: number }> = []
    const cancelSides: BorosSide[] = []
    for (const side of sides) {
      const band = sample.band[side]
      if (band.range <= 0 || band.budgetPerHour <= 0) continue   // nothing to farm on this side right now
      const mine = resting.filter(o => o.side === side)
      const restingApr = mine[0]?.apr ?? (dryRun ? state[side]?.apr : undefined)
      const verdict = judgeSide({ side, mid: sample.midApr, range: band.range, restingApr, params: t })
      // More than one of ours on a side (a restart, a lagging read) → a quote
      // consolidates: the executor cancels all of them and rests exactly one.
      if (verdict.action === 'keep' && mine.length <= 1) continue
      if (mine.length > 1) log.warn({ market, side, count: mine.length }, 'several own orders resting — consolidating to one')
      // One emission per side per interval — for 'place' too: the contract
      // read lags the relay by a few seconds, so a fresh order is invisible on
      // the next tick and would be placed twice (seen live: two 50-YU longs).
      if ((state[side]?.ts ?? 0) > now - t.requoteIntervalMs) continue
      log.info({ marketId, side, action: verdict.action, apr: verdict.targetApr, reason: verdict.reason, mid: sample.midApr }, 'quoting')
      orders.push({ side, sizeYu: t.sizeYu, apr: verdict.targetApr })
      state[side] = { apr: verdict.targetApr, ts: now }
    }
    // Sides we no longer quote (config narrowed) get cleaned up once
    for (const side of (['long', 'short'] as BorosSide[]).filter(s => !sides.includes(s))) {
      if (state[side] || resting.some(o => o.side === side)) {
        cancelSides.push(side)
        delete state[side]
      }
    }
    if (orders.length === 0 && cancelSides.length === 0) return out
    out.push(this.instruction('maker', act('requote'), { marketId, tokenId, marginMode: mode, orders, cancelSides, protectOrderIds }, ['boros']))
    await this.store.set(STATE_KEY, state)
    return out
  }
}
