import { z } from 'zod'
import { BaseMonitor, MonitorMode, createLogger } from '@openwhaleorg/core'
import type { MonitorContext, AdapterResolver, MonitorPlotDef, MonitorRecord } from '@openwhaleorg/core'
import type { BorosSession, BorosBookLevel } from '@openwhaleorg/pendle'

/**
 * pendle-strategy/market-watch — one Boros market's maker picture, polled
 * keyless: mid/mark APR, the incentive band per side (campaign), the pools
 * we'd share the budget with, and how much size already rests near each
 * band edge. Key = marketId. This is the strategy's only trigger.
 */

export const marketWatchSchema = z.object({
  marketId: z.number(),
  tokenId: z.number(),
  symbol: z.string(),
  ts: z.number(),
  midApr: z.number().meta({ description: 'Decimal, 0.068 = 6.8%' }),
  markApr: z.number(),
  bestBid: z.number().optional(),
  bestAsk: z.number().optional(),
  nextSettlementTime: z.number(),
  maturity: z.number(),
  /** The venue refuses cross-margin orders here. */
  isolatedOnly: z.boolean(),
  band: z.object({
    long: z.object({ range: z.number(), budgetPerHour: z.number(), poolYu: z.number() }),
    short: z.object({ range: z.number(), budgetPerHour: z.number(), poolYu: z.number() }),
  }),
  /** Resting size (YU) within the band on each side — the competition. */
  bookInBandYu: z.object({ long: z.number(), short: z.number() }),
})
export type MarketWatchSample = z.infer<typeof marketWatchSchema>

export const marketWatchParamsSchema = z.object({
  pollIntervalMs: z.number().int().min(2_000).default(10_000).meta({ displayName: 'Poll Interval (ms)' }),
  campaignRefreshMs: z.number().int().min(10_000).default(60_000).meta({ displayName: 'Campaign Refresh (ms)', description: 'How often the incentive band/budget is re-read (it changes hourly at most)' }),
})
export type MarketWatchOptions = Partial<z.infer<typeof marketWatchParamsSchema>>

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

function sizeInBand(levels: BorosBookLevel[], lo: number, hi: number): number {
  return levels.filter(l => l.apr >= lo && l.apr <= hi).reduce((acc, l) => acc + l.sizeYu, 0)
}

export class MarketWatchMonitor extends BaseMonitor<string, MarketWatchSample> {
  override readonly mode = MonitorMode.Subscribe
  get monitorName() { return 'market-watch' }

  private readonly adapters: AdapterResolver
  private readonly feeds = new Map<string, AbortController>()
  private readonly options: Required<MarketWatchOptions>

  constructor(ctx: MonitorContext, options: MarketWatchOptions = {}) {
    super(ctx?.dataDir !== undefined ? { dataDir: ctx.dataDir } : undefined)
    if (!ctx?.adapters) throw new Error('MarketWatchMonitor: MonitorContext.adapters missing')
    this.adapters = ctx.adapters
    const params = { ...(ctx.params as MarketWatchOptions | undefined), ...options }
    this.options = {
      pollIntervalMs: params.pollIntervalMs ?? 10_000,
      campaignRefreshMs: params.campaignRefreshMs ?? 60_000,
    }
  }

  private get logger() { return createLogger(this.monitorName) }

  override get keySchema() {
    return z.object({
      market: z.string().min(3).meta({
        displayName: 'Boros market',
        placeholder: 'BINANCE-BTCUSDT-25SEP2026',
        description: 'The Boros market symbol (as listed on the venue). Run pendle/scan-incentives to see live markets and budgets.',
        catalogue: { source: 'market', kind: 'pendle/rates' },
      }),
    })
  }

  override get emitSchema() { return marketWatchSchema }

  override plots(): MonitorPlotDef<MarketWatchSample>[] {
    return [
      {
        id: 'apr',
        title: 'Mid APR and the incentive band',
        kind: 'line',
        unit: '%',
        description: 'Mid implied APR with the band edges the maker orders rest at',
        extract: (records: MonitorRecord<MarketWatchSample>[]) => [
          { label: 'mid', points: records.map(r => ({ x: r.ts, y: r.data.midApr * 100 })) },
          { label: 'long edge', points: records.map(r => ({ x: r.ts, y: (r.data.midApr - r.data.band.long.range) * 100 })) },
          { label: 'short edge', points: records.map(r => ({ x: r.ts, y: (r.data.midApr + r.data.band.short.range) * 100 })) },
        ],
      },
      {
        id: 'pool',
        title: 'In-band pool per side (YU)',
        kind: 'line',
        description: 'The liquidity the hourly budget is shared with — smaller is better for us',
        extract: (records: MonitorRecord<MarketWatchSample>[]) => [
          { label: 'long pool', points: records.map(r => ({ x: r.ts, y: r.data.band.long.poolYu })) },
          { label: 'short pool', points: records.map(r => ({ x: r.ts, y: r.data.band.short.poolYu })) },
        ],
      },
    ]
  }

  protected override startSubscribe(key: string): void {
    if (this.feeds.has(key)) return
    const controller = new AbortController()
    this.feeds.set(key, controller)
    void this.runFeed(key, controller.signal)
  }

  protected override stopSubscribe(key: string): void {
    this.feeds.get(key)?.abort()
    this.feeds.delete(key)
  }

  private async runFeed(key: string, signal: AbortSignal): Promise<void> {
    const session = await this.adapters.resolve<BorosSession>('pendle/rates', 'boros')
    // The key is the venue's market symbol (what the picker offers); a bare
    // numeric id is accepted too for hand-typed keys.
    let marketId = /^\d+$/.test(key) ? Number(key) : NaN
    let market: { tokenId: number; symbol: string; maturity: number; isolatedOnly: boolean } | undefined
    let campaignAt = 0
    let band: MarketWatchSample['band'] = {
      long: { range: 0, budgetPerHour: 0, poolYu: 0 },
      short: { range: 0, budgetPerHour: 0, poolYu: 0 },
    }

    let chain: Promise<void> = Promise.resolve()
    const emit = (data: MarketWatchSample): Promise<void> => {
      chain = chain.then(() => this.push(key, data))
      return chain
    }

    while (!signal.aborted) {
      try {
        if (!market) {
          const all = await session.listLiveMarkets()
          const m = all.find(x => (Number.isNaN(marketId) ? x.symbol === key : x.marketId === marketId))
          if (!m) throw new Error(`market "${key}" is not live/whitelisted`)
          marketId = m.marketId
          market = { tokenId: m.tokenId, symbol: m.symbol, maturity: m.maturity, isolatedOnly: m.isolatedOnly }
        }
        const now = Date.now()
        if (now - campaignAt >= this.options.campaignRefreshMs) {
          const c = await session.makerCampaign(marketId)
          const side = (s?: { incentiveRange: number; budgetPerHour: number; currentInRangeLiquidity: string }) => ({
            range: s?.incentiveRange ?? 0,
            budgetPerHour: s?.budgetPerHour ?? 0,
            poolYu: Number(s?.currentInRangeLiquidity ?? 0) / 1e18,
          })
          band = { long: side(c.addLiquidityIncentive?.long), short: side(c.addLiquidityIncentive?.short) }
          campaignAt = now
        }
        const [quote, book] = await Promise.all([session.marketQuote(marketId), session.orderBook(marketId, 0.0001)])
        const mid = quote.midApr
        await emit({
          marketId,
          tokenId: market.tokenId,
          symbol: market.symbol,
          ts: now,
          midApr: mid,
          markApr: quote.markApr,
          ...(quote.bestBid !== undefined ? { bestBid: quote.bestBid } : {}),
          ...(quote.bestAsk !== undefined ? { bestAsk: quote.bestAsk } : {}),
          nextSettlementTime: quote.nextSettlementTime,
          maturity: market.maturity,
          isolatedOnly: market.isolatedOnly,
          band,
          bookInBandYu: {
            long: sizeInBand(book.long, mid - band.long.range, mid),
            short: sizeInBand(book.short, mid, mid + band.short.range),
          },
        })
      } catch (err) {
        this.logger.warn({ marketId, err }, 'market-watch poll failed — retrying next interval')
      }
      await sleep(this.options.pollIntervalMs, signal)
    }
  }
}
