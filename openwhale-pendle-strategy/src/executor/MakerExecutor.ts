import { z } from 'zod'
import { BaseExecutor, createLogger } from '@openwhaleorg/core'
import type { ExecutionInstruction, ExecutionResult, ExecutorCredentialSlot } from '@openwhaleorg/core'
import type { BorosSession, BorosSide, BorosBatchResult } from '@openwhaleorg/pendle'

/**
 * pendle-strategy/maker — the write half of the maker-reward loop over one
 * Boros account slot. Every action is idempotent from the venue's point of
 * view: `quote` re-reads the account's resting orders on that side before it
 * cancels and re-places, so a retried instruction converges instead of
 * stacking orders. Orders are post-only (ADD_LIQUIDITY_ONLY): the venue
 * rejects a crossing order rather than filling it.
 *
 * Every cancel + place goes out as ONE relayed transaction (the relay
 * aggregates the signed calls): `requote` re-quotes any number of sides for
 * a single gas charge — this is what the strategy fires each tick.
 *
 * simulate* variants log the exact venue call without sending it — the
 * strategy's dryRun mode.
 */

const sideSchema = z.enum(['long', 'short'])
const modeSchema = z.enum(['cross', 'isolated']).default('cross').meta({ description: 'Which margin account the order lives in' })

const orderSchema = z.object({
  side: sideSchema,
  sizeYu: z.number().positive().meta({ description: 'Order size in YU (collateral units of notional)' }),
  apr: z.number().meta({ description: 'Resting implied APR, decimal (0.068 = 6.8%)' }),
  keepInside: z.number().optional().meta({ description: 'Band edge the RESTING rate must stay inside of after tick rounding (long: ≥, short: ≤); the executor nudges the request inward until the venue agrees' }),
})

export const makerActionSchemas = {
  requote: z.object({
    marketId: z.number().int(),
    tokenId: z.number().int(),
    orders: z.array(orderSchema).default([]).meta({ description: 'One order per side to rest; whatever else rests on that side is cancelled in the same transaction' }),
    cancelSides: z.array(sideSchema).default([]).meta({ description: 'Sides to clear without re-placing' }),
    protectOrderIds: z.array(z.string()).default([]).meta({ description: 'Baseline orders that must never be cancelled' }),
    marginMode: modeSchema,
  }),
  quote: z.object({
    marketId: z.number().int(),
    tokenId: z.number().int(),
    side: sideSchema,
    sizeYu: z.number().positive().meta({ description: 'Order size in YU (collateral units of notional)' }),
    apr: z.number().meta({ description: 'Resting implied APR, decimal (0.068 = 6.8%)' }),
    protectOrderIds: z.array(z.string()).default([]).meta({ description: 'Baseline orders that must never be cancelled' }),
    marginMode: modeSchema,
  }),
  cancel: z.object({
    marketId: z.number().int(),
    tokenId: z.number().int(),
    side: sideSchema.optional().meta({ description: 'Absent = both sides' }),
    /** Explicit ids to cancel (an operator cleaning up); absent = every non-protected order on the side(s). */
    orderIds: z.array(z.string()).optional(),
    protectOrderIds: z.array(z.string()).default([]),
    marginMode: modeSchema,
  }),
  flatten: z.object({
    marketId: z.number().int(),
    tokenId: z.number().int(),
    marginMode: modeSchema,
    /** The position the account is SUPPOSED to hold (baseline). Only the deviation is flattened. */
    baselineSizeYu: z.number().default(0),
    protectOrderIds: z.array(z.string()).default([]),
    slippage: z.number().min(0).max(0.5).default(0.02).meta({ description: 'How far past the touch the IOC order may reach, as a fraction of APR' }),
  }),
}

export type MakerInstruction = ExecutionInstruction & (
  | { action: 'requote' | 'simulateRequote'; params: z.infer<typeof makerActionSchemas.requote> }
  | { action: 'quote' | 'simulateQuote'; params: z.infer<typeof makerActionSchemas.quote> }
  | { action: 'cancel' | 'simulateCancel'; params: z.infer<typeof makerActionSchemas.cancel> }
  | { action: 'flatten' | 'simulateFlatten'; params: z.infer<typeof makerActionSchemas.flatten> }
)

export class MakerExecutor extends BaseExecutor<MakerInstruction> {
  private get logger() { return createLogger('maker-executor') }

  constructor() {
    // Long-lived venue round-trips through the relay: no framework timeout,
    // no blind retries — idempotency lives inside each action instead.
    super({ timeout: 0, retry: { maxRetries: 0, retryDelay: 500, maxRetryDelay: 30_000 } })
  }

  get executorName(): string { return 'maker' }

  get supportedActions(): string[] {
    return ['requote', 'quote', 'cancel', 'flatten', 'simulateRequote', 'simulateQuote', 'simulateCancel', 'simulateFlatten']
  }

  override get credentials(): readonly ExecutorCredentialSlot[] {
    return [{ label: 'boros', kind: 'pendle/rates' }]
  }

  override get actionSchemas() { return makerActionSchemas }

  private boros(): BorosSession { return this.session<BorosSession>('boros') }

  async execute(instruction: MakerInstruction): Promise<ExecutionResult<MakerInstruction>> {
    const simulate = instruction.action.startsWith('simulate')
    try {
      switch (instruction.action) {
        case 'requote':
        case 'simulateRequote':
          return this.ok(instruction, await this.requote(instruction.params, simulate))
        case 'quote':
        case 'simulateQuote':
          return this.ok(instruction, await this.requote({ ...instruction.params, orders: [{ side: instruction.params.side, sizeYu: instruction.params.sizeYu, apr: instruction.params.apr }], cancelSides: [] }, simulate))
        case 'cancel':
        case 'simulateCancel':
          return this.ok(instruction, await this.cancel(instruction.params, simulate))
        case 'flatten':
        case 'simulateFlatten':
          return this.ok(instruction, await this.flatten(instruction.params, simulate))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.error({ action: instruction.action, err: message }, 'maker action failed')
      return { instruction, status: 'failed', error: message, executedAt: new Date() }
    }
  }

  private ok(instruction: MakerInstruction, data: Record<string, unknown>): ExecutionResult<MakerInstruction> {
    return { instruction, status: 'success', data, executedAt: new Date() }
  }

  /**
   * One transaction: cancel everything of ours on the touched sides, rest the
   * new orders. Sides are touched when they appear in `orders` (re-quote) or
   * `cancelSides` (clear); untouched sides keep resting.
   */
  private async requote(p: z.infer<typeof makerActionSchemas.requote>, simulate: boolean): Promise<Record<string, unknown>> {
    const boros = this.boros()
    const protectedIds = new Set(p.protectOrderIds)
    const touched = new Set<BorosSide>([...p.orders.map(o => o.side as BorosSide), ...(p.cancelSides as BorosSide[])])
    const resting = await boros.restingOrders(p.marketId, p.tokenId, p.marginMode)
    const cancelIds = resting.filter(o => touched.has(o.side) && !protectedIds.has(o.orderId)).map(o => o.orderId)
    if (simulate) {
      this.logger.info({ ...p, cancelIds }, '[simulate] would cancel + place post-only in one transaction')
      return { simulated: true, cancelled: cancelIds, placed: p.orders.map(o => ({ ...o, marginMode: p.marginMode })) }
    }
    if (cancelIds.length === 0 && p.orders.length === 0) return { cancelled: [], placed: [] }
    if (p.orders.length > 0) await boros.ensureEntered(p.marketId, p.tokenId, p.marginMode)
    const orders = await Promise.all(p.orders.map(o => this.snapInside(boros, p.marketId, o)))
    const result: BorosBatchResult = await boros.batchRequote({ marketId: p.marketId, tokenId: p.tokenId, mode: p.marginMode, cancelIds, orders })
    if (result.errors.length > 0 && result.placed.length === 0 && result.cancelled.length === 0) throw new Error(result.errors.join('; '))
    if (result.errors.length > 0) this.logger.warn({ marketId: p.marketId, errors: result.errors }, 'batch landed with per-call errors')
    this.logger.info({ marketId: p.marketId, orders, cancelled: result.cancelled.length, placed: result.placed.length, txHash: result.txHash }, 'maker orders re-quoted in one transaction')
    return { ...result, requested: orders }
  }

  /**
   * The venue rounds a requested rate to its tick grid, and a target set just
   * inside the band edge can round to just OUTSIDE it — an order that earns
   * nothing and that the strategy re-quotes to the same tick forever (seen
   * live: 4.90% resting against a 4.91% edge, cancelled and replaced every
   * tick). Ask the venue where the order would land and step the request
   * inward, one gap at a time, until it lands inside.
   */
  private async snapInside(boros: BorosSession, marketId: number, o: z.infer<typeof orderSchema>): Promise<{ side: BorosSide; sizeYu: number; apr: number }> {
    const side = o.side as BorosSide
    if (o.keepInside === undefined) return { side, sizeYu: o.sizeYu, apr: o.apr }
    const inside = (rate: number) => (side === 'long' ? rate >= o.keepInside! : rate <= o.keepInside!)
    let apr = o.apr
    for (let i = 0; i < 6; i++) {
      let actual: number
      try { actual = await boros.resolveRate({ marketId, side, sizeYu: o.sizeYu, apr }) } catch { break }
      if (inside(actual)) {
        if (apr !== o.apr) this.logger.info({ marketId, side, requested: o.apr, adjusted: apr, resting: actual, edge: o.keepInside }, 'target snapped inward to stay in band')
        return { side, sizeYu: o.sizeYu, apr }
      }
      const gap = Math.abs(o.keepInside! - actual) + 0.0001
      apr = side === 'long' ? apr + gap : apr - gap
    }
    return { side, sizeYu: o.sizeYu, apr }
  }

  private async cancel(p: z.infer<typeof makerActionSchemas.cancel>, simulate: boolean): Promise<Record<string, unknown>> {
    const boros = this.boros()
    const protectedIds = new Set(p.protectOrderIds)
    const resting = (await boros.restingOrders(p.marketId, p.tokenId, p.marginMode)).filter(o => (p.side === undefined || o.side === p.side) && !protectedIds.has(o.orderId))
    const wanted = p.orderIds ? new Set(p.orderIds) : undefined
    const ids = resting.filter(o => !wanted || wanted.has(o.orderId)).map(o => o.orderId)
    if (simulate) {
      this.logger.info({ ...p, ids }, '[simulate] would cancel')
      return { simulated: true, cancelled: ids }
    }
    await boros.cancelOrders(p.marketId, p.tokenId, ids, p.marginMode)
    return { cancelled: ids }
  }

  /**
   * The accident path: one of OUR orders got filled, so the cross position
   * deviates from the baseline the account held at activation. Cancel our
   * (non-baseline) orders so nothing else fills meanwhile, then IOC the
   * deviation back — the baseline position itself is never touched.
   */
  private async flatten(p: z.infer<typeof makerActionSchemas.flatten>, simulate: boolean): Promise<Record<string, unknown>> {
    const boros = this.boros()
    const position = await boros.crossPosition(p.marketId, p.tokenId, p.marginMode)
    const delta = (position?.signedSizeYu ?? 0) - p.baselineSizeYu
    if (Math.abs(delta) < 1e-9) return { flat: true }
    const quote = await boros.marketQuote(p.marketId)
    const side: BorosSide = delta > 0 ? 'short' : 'long'
    const touch = side === 'short' ? (quote.bestBid ?? quote.midApr) : (quote.bestAsk ?? quote.midApr)
    const apr = side === 'short' ? touch * (1 - p.slippage) : touch * (1 + p.slippage)
    const protectedIds = new Set(p.protectOrderIds)
    const ours = (await boros.restingOrders(p.marketId, p.tokenId, p.marginMode)).filter(o => !protectedIds.has(o.orderId)).map(o => o.orderId)
    if (simulate) {
      this.logger.info({ marketId: p.marketId, delta, side, apr, cancel: ours }, '[simulate] would cancel ours + IOC the deviation')
      return { simulated: true, deltaYu: delta, side, apr, cancelled: ours }
    }
    await boros.cancelOrders(p.marketId, p.tokenId, ours, p.marginMode)
    const result = await boros.takerOrder({ marketId: p.marketId, tokenId: p.tokenId, side, sizeYu: Math.abs(delta), apr, mode: p.marginMode })
    this.logger.warn({ marketId: p.marketId, delta, side, apr }, 'deviation from baseline flattened after an accidental fill')
    return { deltaYu: delta, side, apr, cancelled: ours, result }
  }
}
