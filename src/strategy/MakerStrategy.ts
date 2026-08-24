import { z } from 'zod'
import { BaseStrategy, createLogger } from '@openwhaleorg/core'
import type { ExecutionInstruction, StrategyContext, StrategyParams, Trigger, StrategyDeclarations, MonitorSource } from '@openwhaleorg/core'
import { BorosRatesAccount } from '@jarei/openwhale-pendle'
import type { BorosSide } from '@jarei/openwhale-pendle'
import type { MarketWatchSample } from '../monitor/MarketWatchMonitor.js'
import { judgeSide } from './corridor.js'

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
 */

const decls = {
  monitors: [{ name: 'pendle-maker/market-watch', label: 'watch' }],
  executors: [{ name: 'pendle-maker/maker', label: 'maker' }],
  accounts: [{ account: BorosRatesAccount, label: 'boros' }],
} as const satisfies StrategyDeclarations

interface SideState {
  /** Last APR we asked the executor to rest at. */
  apr: number
  ts: number
}

interface MakerState {
  long?: SideState
  short?: SideState
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

  readonly baseParamsSchema = z.object({
    market: z.string().min(3).meta({
      displayName: 'Boros market',
      description: 'One instance quotes one market. Pick from the venue\'s live markets; run pendle/scan-incentives to see which have a budget and a small pool.',
      catalogue: { source: 'market', kind: 'pendle/rates' },
    }),
    dryRun: z.boolean().default(true).meta({
      displayName: '模拟运行 (Dry Run)',
      description: 'Follows the band and logs every cancel/place it would send, without sending. Switch off explicitly to go live.',
    }),
  })

  readonly tunableParamsSchema = z.object({
    sizeYu: z.number().positive().default(10).meta({
      section: '规模', displayName: '每侧挂单量 (YU)',
      description: '1 YU = 1 unit of the market\'s collateral token of funding notional. Reward share = sizeYu / (pool + sizeYu) per side.',
    }),
    sides: z.enum(['both', 'long', 'short']).default('both').meta({
      section: '规模', displayName: '挂单方向',
      description: 'both = double-sided (each side has its own budget and pool). Single-sided only if you have a view.',
    }),
    edgeRatio: z.number().min(0.5).max(1).default(0.95).meta({
      section: '走廊', displayName: '挂单位置 (带宽比例)',
      description: 'Resting distance from mid as a fraction of the band half-width. 0.95 = just inside the far edge (rounding protection).',
    }),
    safeDistanceRatio: z.number().min(0.05).max(0.9).default(0.3).meta({
      section: '走廊', displayName: '安全内线 (带宽比例)',
      description: 'Re-quote away when mid comes closer than this fraction of the half-width — fill risk rises fast near the touch.',
    }),
    requoteIntervalMs: z.number().int().min(1_000).default(10_000).meta({
      section: '走廊', displayName: '最小重挂间隔 (ms)',
      description: 'Per side. Every re-quote is a relayed cancel + place; this bounds churn in fast markets.',
    }),
    gasFloorUsd: z.number().min(0).default(3).meta({
      section: '风控', displayName: 'Gas 余额地板 (USD)',
      description: 'Relayed actions are paid from the account\'s on-chain USD gas balance. Below this, quoting pauses (a dry balance fails silently).',
    }),
    flattenSlippage: z.number().min(0).max(0.2).default(0.02).meta({
      section: '风控', displayName: '平仓滑点 (APR 比例)',
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
    const { market, dryRun } = this.baseParamsSchema.parse(this.params.base)
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
    const account = this.account('boros')
    const state = (await this.store.get<MakerState>(STATE_KEY)) ?? {}
    const out: ExecutionInstruction[] = []
    const now = Date.now()

    // ── Accident check first: a fill means we hold rate risk we never wanted ──
    const position = await account.position(marketId, tokenId).catch(() => undefined)
    if (position && Math.abs(position.signedSizeYu) > 1e-9) {
      if ((state.lastFlattenTs ?? 0) < now - 30_000) {
        log.warn({ marketId, signedSizeYu: position.signedSizeYu }, 'accidental fill — flattening')
        out.push(this.instruction('maker', act('flatten'), { marketId, tokenId, slippage: t.flattenSlippage }, ['boros']))
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

    // ── Corridor per side ───────────────────────────────────────────────────
    const resting = await account.openOrders(marketId, tokenId).catch(() => [])
    const sides: BorosSide[] = t.sides === 'both' ? ['long', 'short'] : [t.sides]
    let dirty = false
    for (const side of sides) {
      const band = sample.band[side]
      if (band.range <= 0 || band.budgetPerHour <= 0) continue   // nothing to farm on this side right now
      const mine = resting.filter(o => o.side === side)
      const restingApr = mine[0]?.apr ?? (dryRun ? state[side]?.apr : undefined)
      const verdict = judgeSide({ side, mid: sample.midApr, range: band.range, restingApr, params: t })
      if (verdict.action === 'keep') continue
      if (verdict.action === 'requote' && (state[side]?.ts ?? 0) > now - t.requoteIntervalMs) continue
      log.info({ marketId, side, action: verdict.action, apr: verdict.targetApr, reason: verdict.reason, mid: sample.midApr }, 'quoting')
      out.push(this.instruction('maker', act('quote'), { marketId, tokenId, side, sizeYu: t.sizeYu, apr: verdict.targetApr }, ['boros']))
      state[side] = { apr: verdict.targetApr, ts: now }
      dirty = true
    }
    // Sides we no longer quote (config narrowed) get cleaned up once
    for (const side of (['long', 'short'] as BorosSide[]).filter(s => !sides.includes(s))) {
      if (state[side] || resting.some(o => o.side === side)) {
        out.push(this.instruction('maker', act('cancel'), { marketId, tokenId, side }, ['boros']))
        delete state[side]
        dirty = true
      }
    }
    if (dirty) await this.store.set(STATE_KEY, state)
    return out
  }
}
