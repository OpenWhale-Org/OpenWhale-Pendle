import { z } from 'zod'
import { BaseStrategy, createLogger } from '@openwhaleorg/core'
import type { ExecutionInstruction, ParamPreset, PresetContext, StrategyContext, StrategyParams, Trigger, StrategyDeclarations, MonitorSource } from '@openwhaleorg/core'
import { BorosRatesAccount, scanMakerIncentives } from '@openwhaleorg/pendle'
import type { MarketPlan } from '@openwhaleorg/pendle'
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

  override readonly presetSource = {
    title: { en: 'Maker-incentive markets', 'zh-CN': '做市激励市场' },
    description: { en: 'Every Boros market with a live maker budget, ranked by what $1,000 of collateral would earn resting at the band edge — the venue\'s own margin requirement and its payout ceiling included. Each card sets the market and a size that fits.', 'zh-CN': '每个有做市预算的 Boros 市场，按 $1,000 抵押品挂在区间边缘能赚多少排序——已计入交易所自己的保证金要求和发放上限。每张卡片设置市场和一个合适的规模。' },
    ttlMs: 120_000,
  }

  /**
   * The scan-incentives Script, as cards. Sized to $1,000 (the Script's
   * default) unless the form already holds a fixed size, in which case that
   * size is what the card proposes to keep.
   */
  override async presets(ctx: PresetContext): Promise<ParamPreset[]> {
    const scan = await scanMakerIncentives({ capitalUsd: 1_000, sides: 'both', marginUse: 0.8, edgeRatio: 0.95, ...(ctx.signal ? { signal: ctx.signal } : {}) })
    return scan.plans.map(plan => makerPreset(plan, scan.pendleUsd))
  }

  readonly baseParamsSchema = z.object({
    market: z.string().min(3).meta({
      displayName: 'Boros market',
      description: 'One instance quotes one market. Pick from the venue\'s live markets; run pendle/scan-incentives to see which have a budget and a small pool.',
      catalogue: { source: 'market', kind: 'pendle/rates' }, i18n: { 'zh-CN': { displayName: 'Boros 市场', description: '一个实例只做一个市场。从交易所在线市场里选；运行 pendle/scan-incentives 看哪些有预算且池子小。' } }
    }),
    marginMode: z.enum(['auto', 'cross', 'isolated']).default('auto').meta({
      displayName: 'Margin mode',
      description: 'Which margin account the orders live in. auto = isolated when the venue marks the market isolated-only, else cross. The baseline snapshot and all reads/cancels are scoped to this account.', i18n: { 'zh-CN': { displayName: '保证金模式', description: '订单所在的保证金账户。auto = 交易所标记为仅逐仓时用逐仓，否则全仓。基线快照和所有读取/撤单都限定在这个账户内。' } }
    }),
    baselineSnapshot: z.boolean().default(true).meta({
      displayName: 'Baseline snapshot',
      description: 'On every activation, record the position and resting orders the cross account already holds on this market and never touch them: only add orders on top, flatten only deviations. Best effort — the venue does not isolate the account, so a manual trade after activation looks like a fill. Recommended: run on a dedicated sub-account. Off = everything on the market is treated as the strategy\'s own.', i18n: { 'zh-CN': { displayName: '基线快照', description: '每次激活时记录全仓账户在该市场已有的持仓和挂单，并且绝不动它们：只在其上追加订单、只平偏差。尽力而为——交易所不隔离账户，激活后的手动交易看起来像一次成交。建议在专用子账户运行。关 = 该市场上的一切都视为策略自己的。' } }
    }),
  })

  readonly tunableParamsSchema = z.object({
    sizeMode: z.enum(['fixed', 'percent']).default('fixed').meta({
      section: 'Size', displayName: 'Size mode',
      description: 'fixed = the same YU every time. percent = a share of what this account\'s margin can open right now, recomputed every tick — the size follows the balance up and down.', i18n: { 'zh-CN': { section: '规模', displayName: '规模模式', description: 'fixed = 每次相同的 YU。percent = 该账户保证金当前可开规模的一个比例，每个 tick 重新计算——规模随余额上下浮动。' } }
    }),
    sizeYu: z.number().positive().default(10).meta({
      section: 'Size', displayName: 'Order size per side (YU)',
      description: 'Fixed mode only. 1 YU = 1 unit of the market\'s collateral token of funding notional. Reward share = sizeYu / (pool + sizeYu) per side.', i18n: { 'zh-CN': { section: '规模', displayName: '每边订单规模（YU）', description: '仅固定模式。1 YU = 1 单位该市场抵押品代币的资金费名义。奖励份额 = sizeYu / (池子 + sizeYu)，每边各算。' } }
    }),
    sizePercent: z.number().min(1).max(100).default(75).meta({
      section: 'Size', displayName: 'Size (% of margin capacity)',
      description: 'Percent mode only. Capacity = this margin account\'s equity ÷ what the venue asks per YU at the resting rate, minus whatever the baseline already occupies. Applied PER SIDE, not split between them: on a rate market the two sides largely offset, so 75% means 75% on each.', i18n: { 'zh-CN': { section: '规模', displayName: '规模（保证金容量的 %）', description: '仅百分比模式。容量 = 该保证金账户权益 ÷ 交易所在挂单利率下对每 YU 的要求，再减去基线已占用的部分；百分比按每边分别应用。' } }
    }),
    resizeTolerance: z.number().min(0.01).max(1).default(0.1).meta({
      section: 'Size', displayName: 'Resize threshold (× size)',
      description: 'Percent mode only. Re-quote when the target size drifts this far from what is resting. Capacity moves with every mark-to-market tick, and each re-quote is a relayed transaction that costs gas — without a threshold the strategy would spend the day paying to chase noise.', i18n: { 'zh-CN': { section: '规模', displayName: '调整阈值（× 规模）', description: '仅百分比模式。目标规模与挂单规模偏离到这个程度时重挂。容量随每次按市值计价的 tick 变动，每次重挂都是一笔中继交易。' } }
    }),
    sides: z.enum(['both', 'long', 'short']).default('both').meta({
      section: 'Size', displayName: 'Sides',
      description: 'both = double-sided (each side has its own budget and pool). Single-sided only if you have a view.', i18n: { 'zh-CN': { section: '规模', displayName: '方向', description: 'both = 双边（每边有各自的预算和池子）。只有你有方向观点时才单边。' } }
    }),
    edgeRatio: z.number().min(0.5).max(1).default(0.95).meta({
      section: 'Corridor', displayName: 'Resting distance (× half-width)',
      description: 'Resting distance from mid as a fraction of the band half-width. 0.95 = just inside the far edge (rounding protection).', i18n: { 'zh-CN': { section: '走廊', displayName: '挂单距离（× 半宽）', description: '距中间价的挂单距离，以区间半宽的比例计。0.95 = 刚好在远端边缘内侧（防取整）。' } }
    }),
    safeDistanceRatio: z.number().min(0.05).max(0.9).default(0.3).meta({
      section: 'Corridor', displayName: 'Safe distance (× half-width)',
      description: 'Re-quote away when mid comes closer than this fraction of the half-width — fill risk rises fast near the touch.', i18n: { 'zh-CN': { section: '走廊', displayName: '安全距离（× 半宽）', description: '中间价靠近到半宽的这个比例以内时往外重挂——靠近盘口时成交风险上升很快。' } }
    }),
    requoteIntervalMs: z.number().int().min(5_000).default(30_000).meta({
      section: 'Corridor', displayName: 'Min re-quote interval (ms)',
      description: 'Per side, for placing AND re-quoting. Every emission is one relayed transaction (cancel + place), and the contract read lags the relay by a few seconds — shorter than ~15s risks stacking a duplicate order.', i18n: { 'zh-CN': { section: '走廊', displayName: '最短重挂间隔（毫秒）', description: '每边分别计，挂单和重挂都适用。每次发出都是一笔中继交易（撤 + 挂），合约读取比中继滞后几秒。' } }
    }),
    gasFloorUsd: z.number().min(0).default(3).meta({
      section: 'Risk', displayName: 'Gas balance floor (USD)',
      description: 'Relayed actions are paid from the account\'s on-chain USD gas balance. Below this, quoting pauses (a dry balance fails silently).', i18n: { 'zh-CN': { section: '风险', displayName: 'Gas 余额下限（USD）', description: '中继操作从账户链上 USD gas 余额扣费。低于此值暂停挂单（余额耗尽会静默失败）。' } }
    }),
    flattenSlippage: z.number().min(0).max(0.2).default(0.02).meta({
      section: 'Risk', displayName: 'Flatten slippage (× APR)',
      description: 'The limit on the closing IOC itself — how far past the touch it may reach before giving up. Not the decision of whether to cross; that is the Fill section.', i18n: { 'zh-CN': { section: '风险', displayName: '平仓滑点（× 年化）', description: '平仓 IOC 本身的上限——越过盘口多远就放弃。不是“要不要吃单”的决定；那在“成交”一节。' } }
    }),
    fillSlippage: z.number().min(0).max(0.5).default(0.005).meta({
      section: 'Fill', displayName: 'Acceptable close slippage',
      description: 'Cross straight away when the venue simulates the close landing within this far of the touch. Measured on the WHOLE size against the book, so it is the real cost, not the spread. 0 = always cross, whatever it costs.', i18n: { 'zh-CN': { section: '成交', displayName: '可接受的平仓滑点', description: '交易所模拟的平仓落在离盘口这么近的范围内就直接吃单。按整个规模对盘口测算，所以是真实的滑点。' } }
    }),
    fillPolicy: z.enum(['limit', 'partial', 'ladder', 'hold']).default('limit').meta({
      section: 'Fill', displayName: 'When the close is too expensive',
      description: 'limit = rest a post-only close at the touch and wait. partial = cross only the part the book absorbs within budget, rest the remainder. ladder = cross a slice per interval, rest the remainder between slices. hold = keep the position untouched.', i18n: { 'zh-CN': { section: '成交', displayName: '平仓太贵时', description: 'limit = 在盘口挂 post-only 平仓单等待。partial = 只吃掉盘口在预算内能吸收的部分，其余挂单。ladder = 分批吃单。' } }
    }),
    fillTimeoutMs: z.number().int().min(0).default(600_000).meta({
      section: 'Fill', displayName: 'Force-close after (ms)',
      description: 'Once the position has been outstanding this long, cross regardless of cost. Waiting for a better price has no natural end, and an open position on a strategy that wants none is a risk that grows with time. 0 = never force.', i18n: { 'zh-CN': { section: '成交', displayName: '强制平仓等待（毫秒）', description: '仓位挂了这么久之后，不计成本吃单平掉。等更好的价格没有自然终点，而一个意外的仓位一直敞着。' } }
    }),
    fillStopDistance: z.number().min(0).max(1).default(0.15).meta({
      section: 'Fill', displayName: 'Synthetic stop (× entry APR)',
      description: 'Cross regardless of cost once mid has moved this far against the position. SYNTHETIC: Boros has no stop orders, so the strategy watches and fires the IOC itself — it protects only while the engine is running, and reacts no faster than one tick. 0 = off.', i18n: { 'zh-CN': { section: '成交', displayName: '合成止损（× 入场年化）', description: '中间价对仓位不利地移动到这个程度时，不计成本吃单。合成的：Boros 没有止损单，由策略监视并触发。' } }
    }),
    fillSlices: z.number().int().min(2).max(20).default(4).meta({
      section: 'Fill', displayName: 'Ladder slices',
      description: 'Ladder policy only. Each slice is its own relayed transaction with its own gas — split further than the spread you are saving and the ladder costs more than crossing once.', i18n: { 'zh-CN': { section: '成交', displayName: '阶梯分批数', description: '仅阶梯策略。每一批都是一笔单独的中继交易、各付 gas——拆得比省下的价差还细，阶梯反而更贵。' } }
    }),
    fillSliceIntervalMs: z.number().int().min(5_000).default(60_000).meta({
      section: 'Fill', displayName: 'Ladder interval (ms)',
      description: 'Ladder policy only. How long between slices.', i18n: { 'zh-CN': { section: '成交', displayName: '阶梯间隔（毫秒）', description: '仅阶梯策略。每批之间的间隔。' } }
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

  private async evaluateInner(context: StrategyContext): Promise<ExecutionInstruction[]> {
    const { market, baselineSnapshot, marginMode: modeParam } = this.baseParamsSchema.parse(this.params.base)
    const t = this.tunableParamsSchema.parse(this.params.tunable)
    // Dry run is the instance's option: the engine records what this returns without sending it.
    const act = (action: string) => action

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
      // Under the framework's dry run nothing rests on the venue; the quote this would have rested is remembered instead.
      const restingApr = mine[0]?.apr ?? (context.dryRun ? state[side]?.apr : undefined)
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

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`

/** One scanned market as a preset: the market, a size both sides fit, and the figures the ranking was made from. */
export function makerPreset(plan: MarketPlan, pendleUsd: number): ParamPreset {
  const sizeYu = Math.min(...plan.sides.map(s => s.sizeYu))
  const badges: NonNullable<NonNullable<ParamPreset['card']>['badges']> = []
  if (plan.capped) badges.push({ text: { en: 'at ceiling', 'zh-CN': '已到上限' }, tone: 'muted' })
  if (plan.capUnknown) badges.push({ text: { en: 'no ceiling published', 'zh-CN': '未公布上限' }, tone: 'negative' })
  if (plan.isolatedOnly) badges.push({ text: { en: 'isolated', 'zh-CN': '逐仓' }, tone: 'muted' })
  if (plan.daysToMaturity < 7) badges.push({ text: `${plan.daysToMaturity.toFixed(0)}d left`, tone: 'negative' })
  return {
    id: plan.symbol,
    label: `${plan.symbol} · ${pct(plan.aprOnCapital)} on $1k`,
    description: `${(plan.rewardPerHour * 24).toFixed(2)} PENDLE/day ≈ $${plan.usdPerDay.toFixed(2)} at PENDLE $${pendleUsd.toFixed(3)}; ${sizeYu} YU per side.`,
    base: { market: plan.symbol, marginMode: 'auto' },
    tunable: { sizeMode: 'fixed', sizeYu },
    card: {
      title: plan.symbol,
      subtitle: `${plan.collateral} · mid ${pct(plan.midApr, 2)} · ±${pct(plan.sides[0]?.range ?? 0, 2)}`,
      headline: { label: { en: 'APR on $1k', 'zh-CN': '$1k 年化' }, value: pct(plan.aprOnCapital), tone: plan.capUnknown ? 'muted' : 'positive' },
      rows: [
        { label: { en: 'PENDLE / day', 'zh-CN': 'PENDLE / 天' }, value: `${(plan.rewardPerHour * 24).toFixed(2)} ≈ $${plan.usdPerDay.toFixed(2)}` },
        { label: { en: 'size per side', 'zh-CN': '每边规模' }, value: `${sizeYu} YU` },
        { label: { en: 'pool in band', 'zh-CN': '区间内池子' }, value: plan.sides.map(s => `${s.side === 'long' ? 'L' : 'S'} ${s.poolYu.toFixed(0)}`).join(' · ') },
        { label: { en: 'matures', 'zh-CN': '到期' }, value: `${plan.daysToMaturity.toFixed(0)}d` },
      ],
      badges,
      group: plan.daysToMaturity >= 14 ? { en: 'Two weeks or more', 'zh-CN': '两周以上' } : { en: 'Maturing soon', 'zh-CN': '即将到期' },
    },
  }
}
