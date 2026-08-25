import { z } from 'zod'
import { BaseExecutor, createLogger } from '@openwhaleorg/core'
import type { ExecutionInstruction, ExecutionResult, ExecutorCredentialSlot } from '@openwhaleorg/core'
import type { BorosSession, BorosSide } from '@jarei/openwhale-pendle'

/**
 * pendle-maker/maker — the write half of the maker-reward loop over one
 * Boros account slot. Every action is idempotent from the venue's point of
 * view: `quote` re-reads the account's resting orders on that side before it
 * cancels and re-places, so a retried instruction converges instead of
 * stacking orders. Orders are post-only (ADD_LIQUIDITY_ONLY): the venue
 * rejects a crossing order rather than filling it.
 *
 * simulate* variants log the exact venue call without sending it — the
 * strategy's dryRun mode.
 */

const sideSchema = z.enum(['long', 'short'])

export const makerActionSchemas = {
  quote: z.object({
    marketId: z.number().int(),
    tokenId: z.number().int(),
    side: sideSchema,
    sizeYu: z.number().positive().meta({ description: 'Order size in YU (collateral units of notional)' }),
    apr: z.number().meta({ description: 'Resting implied APR, decimal (0.068 = 6.8%)' }),
    protectOrderIds: z.array(z.string()).default([]).meta({ description: 'Baseline orders that must never be cancelled' }),
  }),
  cancel: z.object({
    marketId: z.number().int(),
    tokenId: z.number().int(),
    side: sideSchema.optional().meta({ description: 'Absent = both sides' }),
    protectOrderIds: z.array(z.string()).default([]),
  }),
  flatten: z.object({
    marketId: z.number().int(),
    tokenId: z.number().int(),
    /** The position the account is SUPPOSED to hold (baseline). Only the deviation is flattened. */
    baselineSizeYu: z.number().default(0),
    protectOrderIds: z.array(z.string()).default([]),
    slippage: z.number().min(0).max(0.5).default(0.02).meta({ description: 'How far past the touch the IOC order may reach, as a fraction of APR' }),
  }),
}

export type MakerInstruction = ExecutionInstruction & (
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
    return ['quote', 'cancel', 'flatten', 'simulateQuote', 'simulateCancel', 'simulateFlatten']
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
        case 'quote':
        case 'simulateQuote':
          return this.ok(instruction, await this.quote(instruction.params, simulate))
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

  /** Cancel whatever rests on this side, then place the one order that should. */
  private async quote(p: z.infer<typeof makerActionSchemas.quote>, simulate: boolean): Promise<Record<string, unknown>> {
    const boros = this.boros()
    const protectedIds = new Set(p.protectOrderIds)
    const resting = (await boros.restingOrders(p.marketId, p.tokenId)).filter(o => o.side === p.side && !protectedIds.has(o.orderId))
    const cancelIds = resting.map(o => o.orderId)
    if (simulate) {
      this.logger.info({ ...p, cancelIds }, '[simulate] would cancel + place post-only')
      return { simulated: true, cancelled: cancelIds, placed: { side: p.side, sizeYu: p.sizeYu, apr: p.apr } }
    }
    await boros.ensureEntered(p.marketId, p.tokenId)
    await boros.cancelOrders(p.marketId, p.tokenId, cancelIds)
    const placed = await boros.placeMakerOrder({ marketId: p.marketId, tokenId: p.tokenId, side: p.side as BorosSide, sizeYu: p.sizeYu, apr: p.apr })
    this.logger.info({ marketId: p.marketId, side: p.side, apr: p.apr, sizeYu: p.sizeYu, cancelled: cancelIds.length }, 'maker order re-quoted')
    return { cancelled: cancelIds, placed }
  }

  private async cancel(p: z.infer<typeof makerActionSchemas.cancel>, simulate: boolean): Promise<Record<string, unknown>> {
    const boros = this.boros()
    const protectedIds = new Set(p.protectOrderIds)
    const resting = (await boros.restingOrders(p.marketId, p.tokenId)).filter(o => (p.side === undefined || o.side === p.side) && !protectedIds.has(o.orderId))
    const ids = resting.map(o => o.orderId)
    if (simulate) {
      this.logger.info({ ...p, ids }, '[simulate] would cancel')
      return { simulated: true, cancelled: ids }
    }
    await boros.cancelOrders(p.marketId, p.tokenId, ids)
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
    const position = await boros.crossPosition(p.marketId, p.tokenId)
    const delta = (position?.signedSizeYu ?? 0) - p.baselineSizeYu
    if (Math.abs(delta) < 1e-9) return { flat: true }
    const quote = await boros.marketQuote(p.marketId)
    const side: BorosSide = delta > 0 ? 'short' : 'long'
    const touch = side === 'short' ? (quote.bestBid ?? quote.midApr) : (quote.bestAsk ?? quote.midApr)
    const apr = side === 'short' ? touch * (1 - p.slippage) : touch * (1 + p.slippage)
    const protectedIds = new Set(p.protectOrderIds)
    const ours = (await boros.restingOrders(p.marketId, p.tokenId)).filter(o => !protectedIds.has(o.orderId)).map(o => o.orderId)
    if (simulate) {
      this.logger.info({ marketId: p.marketId, delta, side, apr, cancel: ours }, '[simulate] would cancel ours + IOC the deviation')
      return { simulated: true, deltaYu: delta, side, apr, cancelled: ours }
    }
    await boros.cancelOrders(p.marketId, p.tokenId, ours)
    const result = await boros.takerOrder({ marketId: p.marketId, tokenId: p.tokenId, side, sizeYu: Math.abs(delta), apr })
    this.logger.warn({ marketId: p.marketId, delta, side, apr }, 'deviation from baseline flattened after an accidental fill')
    return { deltaYu: delta, side, apr, cancelled: ours, result }
  }
}
