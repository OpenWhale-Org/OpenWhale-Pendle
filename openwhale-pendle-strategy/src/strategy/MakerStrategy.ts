import { z } from 'zod'
import { BaseStrategy, createLogger } from '@openwhaleorg/core'
import type { ExecutionInstruction, StrategyContext, StrategyParams, Trigger, StrategyDeclarations, MonitorSource } from '@openwhaleorg/core'
import { BorosRatesAccount } from '@openwhaleorg/pendle'
import type { BorosSide, BorosMarginMode } from '@openwhaleorg/pendle'
import type { MarketWatchSample } from '../monitor/MarketWatchMonitor.js'
import { judgeSide } from './corridor.js'
import { decideFill } from './fill.js'
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

/** What the venue asks per YU, and when we last asked. */
interface MarginProbe {
  perYu: number
  apr: number
  ts: number
}

/** An accidental fill being worked out of, from the tick it was noticed. */
interface FillState {
  /** When the deviation first appeared — the force-close clock runs from here. */
  since: number
  /** Mid at that moment. The synthetic stop measures the move against us from this. */
  entryApr: number
  /** Deviation at detection — a ladder slices this, not the shrinking remainder. */
  sizeAtDetect: number
  lastSliceTs?: number
  /** `hold` announced, so the log is not repeated every tick. */
  announced?: boolean
}

interface MakerState {
  long?: SideState
  short?: SideState
  /** Set while a position is outstanding; cleared when it is flat again. */
  fill?: FillState
  /** Per side, percent mode only — refreshed no faster than a re-quote could act on it. */
  probe?: Partial<Record<BorosSide, MarginProbe>>
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
    sizeMode: z.enum(['fixed', 'percent']).default('fixed').meta({
      section: 'Size', displayName: 'Size mode',
      description: 'fixed = the same YU every time. percent = a share of what this account\'s margin can open right now, recomputed every tick — the size follows the balance up and down.',
    }),
    sizeYu: z.number().positive().default(10).meta({
      section: 'Size', displayName: 'Order size per side (YU)',
      description: 'Fixed mode only. 1 YU = 1 unit of the market\'s collateral token of funding notional. Reward share = sizeYu / (pool + sizeYu) per side.',
    }),
    sizePercent: z.number().min(1).max(100).default(75).meta({
      section: 'Size', displayName: 'Size (% of margin capacity)',
      description: 'Percent mode only. Capacity = this margin account\'s equity ÷ what the venue asks per YU at the resting rate, minus whatever the baseline already occupies. Applied PER SIDE, not split between them: on a rate market the two sides largely offset, so 75% means 75% on each.',
    }),
    resizeTolerance: z.number().min(0.01).max(1).default(0.1).meta({
      section: 'Size', displayName: 'Resize threshold (× size)',
      description: 'Percent mode only. Re-quote when the target size drifts this far from what is resting. Capacity moves with every mark-to-market tick, and each re-quote is a relayed transaction that costs gas — without a threshold the strategy would spend the day paying to chase noise.',
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
      description: 'The limit on the closing IOC itself — how far past the touch it may reach before giving up. Not the decision of whether to cross; that is the Fill section.',
    }),
    fillSlippage: z.number().min(0).max(0.5).default(0.005).meta({
      section: 'Fill', displayName: 'Acceptable close slippage',
      description: 'Cross straight away when the venue simulates the close landing within this far of the touch. Measured on the WHOLE size against the book, so it is the real cost, not the spread. 0 = always cross, whatever it costs.',
    }),
    fillPolicy: z.enum(['limit', 'partial', 'ladder', 'hold']).default('limit').meta({
      section: 'Fill', displayName: 'When the close is too expensive',
      description: 'limit = rest a post-only close at the touch and wait. partial = cross only the part the book absorbs within budget, rest the remainder. ladder = cross a slice per interval, rest the remainder between slices. hold = keep the position untouched.',
    }),
    fillTimeoutMs: z.number().int().min(0).default(600_000).meta({
      section: 'Fill', displayName: 'Force-close after (ms)',
      description: 'Once the position has been outstanding this long, cross regardless of cost. Waiting for a better price has no natural end, and an open position on a strategy that wants none is a risk that grows with time. 0 = never force.',
    }),
    fillStopDistance: z.number().min(0).max(1).default(0.15).meta({
      section: 'Fill', displayName: 'Synthetic stop (× entry APR)',
      description: 'Cross regardless of cost once mid has moved this far against the position. SYNTHETIC: Boros has no stop orders, so the strategy watches and fires the IOC itself — it protects only while the engine is running, and reacts no faster than one tick. 0 = off.',
    }),
    fillSlices: z.number().int().min(2).max(20).default(4).meta({
      section: 'Fill', displayName: 'Ladder slices',
      description: 'Ladder policy only. Each slice is its own relayed transaction with its own gas — split further than the spread you are saving and the ladder costs more than crossing once.',
    }),
    fillSliceIntervalMs: z.number().int().min(5_000).default(60_000).meta({
      section: 'Fill', displayName: 'Ladder interval (ms)',
      description: 'Ladder policy only. How long between slices.',
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

  /**
   * The largest slice that still crosses within budget.
   *
   * Bisection because the answer is not a formula: it depends on the resting
   * depth, which only the venue knows and only answers one size at a time. Six
   * probes land within ~1.5% of the true edge, and each is a network call, so
   * the count is the accuracy actually worth paying for.
   */
  private async affordableSize(
    account: { closeCost(a: { marketId: number; side: BorosSide; sizeYu: number }): Promise<{ slippage: number }> },
    marketId: number,
    side: BorosSide,
    full: number,
    budget: number,
  ): Promise<number> {
    let fits = 0
    let over = full
    for (let i = 0; i < 6 && over - fits > full * 0.02; i++) {
      const probe = (fits + over) / 2
      if (!(probe > 0)) break
      const cost = await account.closeCost({ marketId, side, sizeYu: probe }).catch(() => undefined)
      if (cost !== undefined && cost.slippage <= budget) fits = probe
      else over = probe
    }
    return fits
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
      /* Our own leftovers from before a restart must not become baseline, or
         every restart stacks a fresh pair on top of the old one.
 
         In FIXED mode an order is ours when it has exactly our size and rests
         inside the band — a signature the operator's hand-placed orders never
         match by accident. PERCENT mode gives that up: our size is by
         construction whatever the balance allowed at the time, so a leftover
         from before a restart matches nothing, and testing it would file our
         own order as untouchable. Band position is what remains, and it is
         weaker — a hand-placed order resting in the band on a percent-mode
         instance will be adopted and re-quoted away. Which is the reason the
         class docstring asks for a dedicated sub-account. */
      const isOurs = (o: { side: BorosSide; apr: number; sizeYu: number }) => {
        if (t.sizeMode === 'fixed' && Math.abs(o.sizeYu - t.sizeYu) > 1e-9) return false
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

    /* ── Accident check ─────────────────────────────────────────────────────
       A position that differs from the baseline means one of OUR orders
       filled. From here until it is flat again the strategy quotes nothing:
       the band edge is where fills come from, and adding more of them while
       already holding inventory is how a bad tick becomes a position.

       Getting flat is a choice between two costs. Crossing pays the spread
       and whatever depth the book lacks; resting pays nothing but has no
       deadline and leaves the rate free to move against us. So the venue is
       asked what crossing would ACTUALLY cost — the whole size simulated
       against the book, not the spread — and that answer, against a budget,
       decides. Above the budget the configured policy takes over, and two
       overrides sit above the policy: a clock, and a move against us. */
    const position = await account.crossPosition(marketId, tokenId, mode).catch(() => undefined)
    const delta = (position?.signedSizeYu ?? 0) - baseline.signedSizeYu
    if (Math.abs(delta) > 1e-9) {
      const closeSide: BorosSide = delta > 0 ? 'short' : 'long'
      const outstanding = Math.abs(delta)
      if (!state.fill) {
        state.fill = { since: now, entryApr: sample.midApr, sizeAtDetect: outstanding }
        log.warn({ marketId, deltaYu: delta, baselineYu: baseline.signedSizeYu, midApr: sample.midApr }, 'an order filled — quoting is paused until the position is flat')
      }
      const fill = state.fill
      delete state.long
      delete state.short

      // Every branch below is one relayed transaction; the interval that
      // paces re-quoting paces these too.
      if ((state.lastFlattenTs ?? 0) > now - t.requoteIntervalMs) {
        await this.store.set(STATE_KEY, state)
        return out
      }
      const base = { marketId, tokenId, marginMode: mode, baselineSizeYu: baseline.signedSizeYu, protectOrderIds }
      const emit = (params: Record<string, unknown>) => {
        out.push(this.instruction('maker', act('flatten'), { ...base, ...params }, ['boros']))
        state.lastFlattenTs = now
      }

      const cost = await account.closeCost({ marketId, side: closeSide, sizeYu: outstanding }).catch((err: unknown) => {
        log.warn({ marketId, err }, 'the venue would not price the close — leaving the position for the next tick')
        return undefined
      })
      const decision = await decideFill(
        {
          outstanding, closeSide, midApr: sample.midApr, now,
          since: fill.since, entryApr: fill.entryApr, sizeAtDetect: fill.sizeAtDetect,
          ...(fill.lastSliceTs !== undefined ? { lastSliceTs: fill.lastSliceTs } : {}),
          ...(cost !== undefined ? { slippage: cost.slippage } : {}),
        },
        t,
        () => this.affordableSize(account, marketId, closeSide, outstanding, t.fillSlippage),
      )
      log.info({ marketId, outstanding, ...(cost ?? {}), decision: decision.action, reason: decision.reason }, 'fill handling')

      if (decision.action === 'cancel-only') {
        // The rule holds even when we are not closing: nothing of ours rests
        // at the edge while a position is open.
        if (!fill.announced) {
          fill.announced = true
          out.push(this.instruction('maker', act('cancel'), { marketId, tokenId, marginMode: mode, protectOrderIds }, ['boros']))
          state.lastFlattenTs = now
        }
      } else if (decision.action === 'rest') {
        emit({ how: 'limit' })
      } else {
        emit({ how: 'ioc', slippage: t.flattenSlippage, ...(decision.maxSizeYu !== undefined ? { maxSizeYu: decision.maxSizeYu } : {}) })
        if (decision.sliced) fill.lastSliceTs = now
      }
      await this.store.set(STATE_KEY, state)
      return out
    }
    if (state.fill) {
      log.info({ marketId, heldMs: now - state.fill.since }, 'position is flat again — resuming quoting')
      delete state.fill
      await this.store.set(STATE_KEY, state)
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
    const allResting = await account.restingOrders(marketId, tokenId, mode).catch(() => [])
    const resting = allResting.filter(o => !protectOrderIds.includes(o.orderId))
    const sides: BorosSide[] = t.sides === 'both' ? ['long', 'short'] : [t.sides]

    /* ── Size ─────────────────────────────────────────────────────────────
       Fixed mode is a number the operator typed. Percent mode is a number the
       BALANCE decides, recomputed here every tick:

         capacity = margin account equity ÷ margin the venue asks per YU
         free     = capacity − what the baseline already occupies
         size     = free × percent

       The margin figure is this ONE account's equity, not the account's free
       margin: free margin nets out the orders we ourselves have resting, so
       sizing against it would shrink the target every time we filled it —
       750 YU resting, 187 next tick, 608 the tick after, for ever, paying gas
       on every swing. Equity does not move when we quote against it.

       The baseline is subtracted because it is untouchable: its position and
       its orders hold margin this strategy may never reclaim, so counting it
       as capacity would size orders the venue then refuses.

       `percent` applies PER SIDE rather than splitting between them — on a
       rate market a long and a short largely offset, so 75% means 75% on
       each. If a venue ever stops netting them the second side is what gets
       rejected, which is why the numbers are logged. */
    const baselineYu = Math.abs(baseline.signedSizeYu)
      + allResting.filter(o => protectOrderIds.includes(o.orderId)).reduce((a, o) => a + o.sizeYu, 0)

    const targetSizeFor = async (side: BorosSide, apr: number): Promise<number | undefined> => {
      if (t.sizeMode === 'fixed') return t.sizeYu
      // Refreshed no faster than a re-quote could act on it — the probe is a
      // network round-trip and the corridor cannot move within one interval.
      const cached = state.probe?.[side]
      let perYu = cached && cached.ts > now - t.requoteIntervalMs ? cached.perYu : undefined
      if (perYu === undefined) {
        perYu = await account.marginPerYu({ marketId, side, apr }).catch((err: unknown) => {
          log.warn({ marketId, side, err }, 'margin probe failed — not sizing this side on a guess')
          return undefined
        })
        if (perYu === undefined || !(perYu > 0)) return undefined
        state.probe = { ...state.probe, [side]: { perYu, apr, ts: now } }
      }
      const equity = await account.marginBalance(marketId, tokenId, mode).catch(() => undefined)
      if (equity === undefined) return undefined
      const capacityYu = equity / perYu
      const freeYu = Math.max(0, capacityYu - baselineYu)
      // Whole YU on stable collateral, two decimals where one YU is a whole BTC
      const raw = (freeYu * t.sizePercent) / 100
      const sized = raw >= 100 ? Math.floor(raw) : Math.floor(raw * 100) / 100
      log.info({ marketId, side, equity, perYu, capacityYu, baselineYu, percent: t.sizePercent, sized }, 'sized from margin')
      return sized > 0 ? sized : undefined
    }
    // Everything this tick wants goes out as ONE requote instruction — the
    // executor turns it into a single relayed transaction (one gas charge).
    const orders: Array<{ side: BorosSide; sizeYu: number; apr: number; keepInside: number }> = []
    const cancelSides: BorosSide[] = []
    for (const side of sides) {
      const band = sample.band[side]
      if (band.range <= 0 || band.budgetPerHour <= 0) continue   // nothing to farm on this side right now
      const mine = resting.filter(o => o.side === side)
      const restingApr = mine[0]?.apr ?? (dryRun ? state[side]?.apr : undefined)
      const verdict = judgeSide({ side, mid: sample.midApr, range: band.range, restingApr, params: t })
      const sizeYu = await targetSizeFor(side, verdict.targetApr)
      if (sizeYu === undefined) continue   // capacity unknown or spent — leave what is resting alone
      /* The corridor decides WHERE, the balance decides HOW MUCH, and either
         can call for a re-quote on its own: a size that has drifted past the
         threshold is as much a reason to move as an order out of band. */
      const drift = mine.length === 1 ? Math.abs(mine[0]!.sizeYu - sizeYu) / sizeYu : Infinity
      const resize = t.sizeMode === 'percent' && mine.length === 1 && drift > t.resizeTolerance
      // More than one of ours on a side (a restart, a lagging read) → a quote
      // consolidates: the executor cancels all of them and rests exactly one.
      if (verdict.action === 'keep' && mine.length <= 1 && !resize) continue
      if (resize) log.info({ market, side, resting: mine[0]!.sizeYu, target: sizeYu, drift }, 'size drifted past the threshold — re-quoting')
      if (mine.length > 1) log.warn({ market, side, count: mine.length }, 'several own orders resting — consolidating to one')
      // One emission per side per interval — for 'place' too: the contract
      // read lags the relay by a few seconds, so a fresh order is invisible on
      // the next tick and would be placed twice (seen live: two 50-YU longs).
      if ((state[side]?.ts ?? 0) > now - t.requoteIntervalMs) continue
      log.info({ marketId, side, action: verdict.action, apr: verdict.targetApr, reason: verdict.reason, mid: sample.midApr }, 'quoting')
      // The band edge itself rides along: the executor makes sure the venue's tick rounding keeps the order inside it
      orders.push({ side, sizeYu, apr: verdict.targetApr, keepInside: side === 'long' ? sample.midApr - band.range : sample.midApr + band.range })
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
