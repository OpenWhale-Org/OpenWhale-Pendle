import { z } from 'zod'
import { BaseExecutor, createLogger } from '@openwhaleorg/core'
import type { ExecutionInstruction, ExecutionResult, ExecutorCredentialSlot } from '@openwhaleorg/core'
import type { BorosSession, BorosSide } from '../session.js'

const log = createLogger('boros-trading')

/**
 * Take a Boros position and hold it: the venue-level counterpart to the
 * maker executor in the strategy package.
 *
 * The maker executor rests quotes for incentives. A fixed-rate carry wants
 * the opposite — cross the book once at the implied APR, hold to maturity,
 * close once — and it belongs in the VENUE package because taking a Boros
 * position is a Boros capability, not any one strategy's. A strategy that
 * pairs Boros with a perp venue (the four-leg carry) sends here for its rate
 * legs and to that venue's executor for the others.
 *
 * Every taker order is simulated first: Boros settles at the rate the book
 * actually gives, and the order is refused when that rate is worse than the
 * caller's `maxSlippageBps` from the touch — a fill at a rate the strategy did
 * not price is a position the strategy did not choose.
 */

const legSchema = z.object({
  marketId: z.number().int().positive().meta({ description: 'Boros market id', i18n: { 'zh-CN': { description: 'Boros 市场 id' } } }),
  tokenId: z.number().int().nonnegative().meta({ description: 'Collateral token id of the market', i18n: { 'zh-CN': { description: '市场的抵押品代币 id' } } }),
  side: z.enum(['long', 'short']).meta({ description: 'long = pay fixed / receive floating; short = receive fixed / pay floating', i18n: { 'zh-CN': { description: 'long = 付固定 / 收浮动；short = 收固定 / 付浮动' } } }),
  sizeYu: z.number().positive().meta({ description: 'Notional in YU (1 YU = 1 unit of underlying funding exposure)', i18n: { 'zh-CN': { description: '名义规模（YU，1 YU = 1 单位标的资金费敞口）' } } }),
  /** Worst acceptable rate, absolute APR; derived from the touch when omitted. */
  limitApr: z.number().optional(),
  maxSlippageBps: z.number().min(0).default(25).meta({ description: 'Refuse when the simulated fill rate is this far from the touch', i18n: { 'zh-CN': { description: '模拟成交利率偏离盘口超过此值时拒绝' } } }),
  mode: z.enum(['cross', 'isolated']).default('cross'),
})

const schemas = {
  /** Cross the book, IOC, at a rate no worse than the touch ± slippage. */
  open: legSchema,
  /** Close the whole position in this market (or `sizeYu` of it), IOC. */
  close: z.object({
    marketId: z.number().int().positive(),
    tokenId: z.number().int().nonnegative(),
    sizeYu: z.number().positive().optional(),
    maxSlippageBps: z.number().min(0).default(50),
    mode: z.enum(['cross', 'isolated']).default('cross'),
  }),
  cancelAll: z.object({
    marketId: z.number().int().positive(),
    tokenId: z.number().int().nonnegative(),
    mode: z.enum(['cross', 'isolated']).default('cross'),
  }),
}

export type BorosTradingInstruction = ExecutionInstruction & { params: Record<string, unknown> }

export class BorosTradingExecutor extends BaseExecutor<BorosTradingInstruction> {
  constructor(options?: { dataDir?: string }) {
    super({
      timeout: 120_000,
      // On-chain: a retried order after an ambiguous answer is a doubled position.
      retry: { maxRetries: 0, retryDelay: 0, maxRetryDelay: 0 },
      maxConcurrent: 1,
      ...(options?.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    })
  }

  get executorName(): string { return 'boros-trading' }
  get supportedActions(): string[] { return ['open', 'simulateOpen', 'close', 'simulateClose', 'cancelAll'] }

  override get credentials(): readonly ExecutorCredentialSlot[] {
    return [{ label: 'boros', kind: 'pendle/rates' }]
  }

  override get actionSchemas() {
    return { open: schemas.open, simulateOpen: schemas.open, close: schemas.close, simulateClose: schemas.close, cancelAll: schemas.cancelAll }
  }

  async execute(instruction: BorosTradingInstruction): Promise<ExecutionResult<BorosTradingInstruction>> {
    const boros = this.session<BorosSession>('boros')
    const simulate = instruction.action.startsWith('simulate')
    const action = simulate ? instruction.action.slice('simulate'.length).replace(/^[A-Z]/, c => c.toLowerCase()) : instruction.action
    try {
      switch (action) {
        case 'open': return await this.open(instruction, boros, schemas.open.parse(instruction.params), simulate)
        case 'close': return await this.close(instruction, boros, schemas.close.parse(instruction.params), simulate)
        case 'cancelAll': {
          const p = schemas.cancelAll.parse(instruction.params)
          await boros.cancelAll(p.marketId, p.tokenId, p.mode)
          return { instruction, status: 'success', data: { marketId: p.marketId }, executedAt: new Date() }
        }
      }
    } catch (err) {
      log.warn({ action: instruction.action, err }, 'refused')
      return { instruction, status: 'failed', error: err instanceof Error ? err.message : String(err), executedAt: new Date() }
    }
    return { instruction, status: 'failed', error: `Unknown action "${instruction.action}"`, executedAt: new Date() }
  }

  private async open(
    instruction: BorosTradingInstruction, boros: BorosSession, p: z.infer<typeof legSchema>, simulate: boolean,
  ): Promise<ExecutionResult<BorosTradingInstruction>> {
    const priced = await this.price(boros, p.marketId, p.side, p.sizeYu, p.limitApr, p.maxSlippageBps)
    if ('error' in priced) return { instruction, status: 'failed', error: priced.error, executedAt: new Date() }
    if (simulate) {
      return { instruction, status: 'success', data: { simulated: true, ...priced, marketId: p.marketId, side: p.side, sizeYu: p.sizeYu }, executedAt: new Date() }
    }
    await boros.ensureEntered(p.marketId, p.tokenId, p.mode)
    const before = await boros.crossPosition(p.marketId, p.tokenId, p.mode)
    const receipt = await boros.takerOrder({ marketId: p.marketId, tokenId: p.tokenId, side: p.side, sizeYu: p.sizeYu, apr: priced.limitApr, mode: p.mode })
    const after = await boros.crossPosition(p.marketId, p.tokenId, p.mode)
    // The position delta is the fill: an IOC that found less than the touch
    // showed is a partial, and the caller sizes its other legs from this.
    const filledYu = Math.abs((after?.signedSizeYu ?? 0) - (before?.signedSizeYu ?? 0))
    return {
      instruction,
      status: filledYu > 0 ? 'success' : 'failed',
      data: {
        marketId: p.marketId, side: p.side, requestedYu: p.sizeYu, filledYu, ...priced,
        position: after, receipt,
        // Attribution: a Boros order id is the transaction; symbol is the market.
        order: { orderId: String((receipt as { txHash?: string }).txHash ?? instruction.messageId), symbol: `boros:${p.marketId}` },
      },
      ...(filledYu > 0 ? {} : { error: 'IOC filled nothing at the limit rate' }),
      executedAt: new Date(),
    }
  }

  private async close(
    instruction: BorosTradingInstruction, boros: BorosSession, p: z.infer<typeof schemas.close>, simulate: boolean,
  ): Promise<ExecutionResult<BorosTradingInstruction>> {
    const position = await boros.crossPosition(p.marketId, p.tokenId, p.mode)
    const held = position?.signedSizeYu ?? 0
    if (Math.abs(held) < 1e-9) return { instruction, status: 'skipped', data: { marketId: p.marketId, reason: 'flat' }, executedAt: new Date() }
    const side: BorosSide = held > 0 ? 'short' : 'long'
    const sizeYu = Math.min(Math.abs(held), p.sizeYu ?? Math.abs(held))
    const priced = await this.price(boros, p.marketId, side, sizeYu, undefined, p.maxSlippageBps)
    if ('error' in priced) return { instruction, status: 'failed', error: priced.error, executedAt: new Date() }
    if (simulate) {
      return { instruction, status: 'success', data: { simulated: true, ...priced, marketId: p.marketId, side, sizeYu }, executedAt: new Date() }
    }
    const receipt = await boros.takerOrder({ marketId: p.marketId, tokenId: p.tokenId, side, sizeYu, apr: priced.limitApr, mode: p.mode })
    const after = await boros.crossPosition(p.marketId, p.tokenId, p.mode)
    const closedYu = Math.abs(held - (after?.signedSizeYu ?? 0))
    return {
      instruction,
      status: closedYu > 0 ? 'success' : 'failed',
      data: { marketId: p.marketId, side, requestedYu: sizeYu, closedYu, ...priced, position: after, receipt,
        order: { orderId: String((receipt as { txHash?: string }).txHash ?? instruction.messageId), symbol: `boros:${p.marketId}` } },
      ...(closedYu > 0 ? {} : { error: 'IOC closed nothing at the limit rate' }),
      executedAt: new Date(),
    }
  }

  /**
   * The rate this size would actually get, and the limit it may not exceed.
   *
   * `closeCost` simulates the fill against the live book. The limit is the
   * touch pushed `maxSlippageBps` in the caller's disfavour; a simulated fill
   * beyond it is refused here rather than discovered on-chain.
   */
  private async price(boros: BorosSession, marketId: number, side: BorosSide, sizeYu: number, limitApr: number | undefined, maxSlippageBps: number) {
    const sim = await boros.closeCost({ marketId, side, sizeYu })
    const touch = sim.touch
    // Long pays fixed: worse is a HIGHER rate. Short receives fixed: worse is lower.
    const worst = limitApr ?? (side === 'long' ? touch * (1 + maxSlippageBps / 10_000) : touch * (1 - maxSlippageBps / 10_000))
    const beyond = side === 'long' ? sim.actualRate > worst : sim.actualRate < worst
    if (beyond) return { error: `Boros market ${marketId}: ${side} ${sizeYu} YU would fill at ${(sim.actualRate * 100).toFixed(3)}% APR, beyond the limit ${(worst * 100).toFixed(3)}% (touch ${(touch * 100).toFixed(3)}%)` }
    return { touchApr: touch, expectedApr: sim.actualRate, limitApr: worst, slippage: sim.slippage }
  }
}
