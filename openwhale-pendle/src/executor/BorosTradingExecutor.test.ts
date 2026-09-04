import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ExecutionInstruction } from '@openwhaleorg/core'
import { BorosTradingExecutor } from './BorosTradingExecutor.js'

/** A Boros session scripted per test: the simulated fill rate, and the position before/after. */
function fakeBoros(script: { touch: number; actualRate: number; positionAfter?: number; positionBefore?: number }) {
  const calls: Array<Record<string, unknown>> = []
  let entered = false
  let position = script.positionBefore ?? 0
  return {
    calls,
    closeCost: async () => ({ touch: script.touch, actualRate: script.actualRate, slippage: 0 }),
    ensureEntered: async () => { entered = true },
    crossPosition: async () => (position === 0 && !calls.length ? undefined : { signedSizeYu: position, positionValue: 0 }),
    takerOrder: async (args: Record<string, unknown>) => {
      calls.push(args)
      position = script.positionAfter ?? position
      return { txHash: '0xabc' }
    },
    cancelAll: async () => { calls.push({ cancelAll: true }) },
    get entered() { return entered },
  }
}

function harness(session: unknown) {
  const executor = new BorosTradingExecutor({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ow-boros-')) })
  executor.setMaterialized('inst', [{ label: 'boros', credentialName: 'Boros Main', session }])
  return (action: string, params: Record<string, unknown>) =>
    executor.fire({ messageId: `m-${Math.random().toString(36).slice(2)}`, executorId: 'boros-trading', action, params, instanceId: 'inst' } as ExecutionInstruction)
}

const open = { marketId: 11, tokenId: 1, side: 'long', sizeYu: 0.1, maxSlippageBps: 25 }

describe('boros-trading', () => {
  it('opens at a limit no worse than the touch plus slippage, and reports the fill from the position delta', async () => {
    const boros = fakeBoros({ touch: 0.06, actualRate: 0.0601, positionAfter: 0.1 })
    const fire = harness(boros)
    const result = await fire('open', open)
    expect(result?.status).toBe('success')
    expect(result?.data).toMatchObject({ filledYu: 0.1, touchApr: 0.06, expectedApr: 0.0601 })
    // Long pays fixed: the limit is the touch pushed UP by 25 bps.
    expect((result?.data as { limitApr: number }).limitApr).toBeCloseTo(0.06 * 1.0025, 9)
    expect(boros.calls[0]).toMatchObject({ marketId: 11, side: 'long', sizeYu: 0.1 })
    expect(boros.entered).toBe(true)
  })

  it('refuses when the simulated fill is beyond the limit, and sends nothing', async () => {
    const boros = fakeBoros({ touch: 0.06, actualRate: 0.07 })
    const fire = harness(boros)
    const result = await fire('open', open)
    expect(result?.status).toBe('failed')
    expect(result?.error).toMatch(/beyond the limit/)
    expect(boros.calls).toHaveLength(0)
  })

  it('a short is worse when the rate is LOWER', async () => {
    const fire = harness(fakeBoros({ touch: 0.10, actualRate: 0.09 }))
    const result = await fire('open', { ...open, side: 'short' })
    expect(result?.status).toBe('failed')
  })

  it('simulates with the same pricing and no order', async () => {
    const boros = fakeBoros({ touch: 0.06, actualRate: 0.0601 })
    const result = await harness(boros)('simulateOpen', open)
    expect(result?.status).toBe('success')
    expect((result?.data as { simulated: boolean }).simulated).toBe(true)
    expect(boros.calls).toHaveLength(0)
  })

  it('close takes the opposite side of what is held, and skips when flat', async () => {
    const boros = fakeBoros({ touch: 0.06, actualRate: 0.06, positionBefore: 0.1, positionAfter: 0 })
    const result = await harness(boros)('close', { marketId: 11, tokenId: 1 })
    expect(result?.status).toBe('success')
    expect(boros.calls[0]).toMatchObject({ side: 'short', sizeYu: 0.1 })
    expect(result?.data).toMatchObject({ closedYu: 0.1 })
    const flat = await harness(fakeBoros({ touch: 0.06, actualRate: 0.06 }))('close', { marketId: 11, tokenId: 1 })
    expect(flat?.status).toBe('skipped')
  })
})

describe('boros-trading — resting', () => {
  function makerBoros() {
    const book: Array<{ orderId: string; side: string; apr: number; sizeYu: number; unfilledYu: number; marketId: number; isCross: boolean }> = [
      { orderId: 'old-1', side: 'long', apr: 0.058, sizeYu: 1, unfilledYu: 1, marketId: 11, isCross: true },
    ]
    const calls: Array<Record<string, unknown>> = []
    return {
      calls,
      ensureEntered: async () => {},
      restingOrders: async () => book.map(o => ({ ...o })),
      placeMakerOrder: async (args: Record<string, unknown>) => {
        calls.push(args)
        if ((args['apr'] as number) >= 0.06) return { txHash: '0xrefused' }   // crossing: the venue rejects a post-only
        book.push({ orderId: 'new-7', side: String(args['side']), apr: args['apr'] as number, sizeYu: args['sizeYu'] as number, unfilledYu: args['sizeYu'] as number, marketId: 11, isCross: true })
        return { txHash: '0xrested' }
      },
      cancelOrders: async (_m: number, _t: number, ids: string[]) => { calls.push({ cancel: ids }); for (const id of ids) { const i = book.findIndex(o => o.orderId === id); if (i >= 0) book.splice(i, 1) } },
    }
  }

  it('rests a post-only and reads its id back from the book', async () => {
    const boros = makerBoros()
    const fire = harness(boros)
    const result = await fire('rest', { marketId: 11, tokenId: 1, side: 'long', sizeYu: 0.1, apr: 0.059 })
    expect(result!.status).toBe('success')
    expect(result!.data).toMatchObject({ orderId: 'new-7', apr: 0.059, order: { orderId: 'new-7', symbol: 'boros:11' } })
    expect(boros.calls[0]).toMatchObject({ side: 'long', sizeYu: 0.1, apr: 0.059 })
  })

  it('a post-only the venue refused is a failure that names it, not a phantom order', async () => {
    const fire = harness(makerBoros())
    const result = await fire('rest', { marketId: 11, tokenId: 1, side: 'long', sizeYu: 0.1, apr: 0.061 })
    expect(result!.status).toBe('failed')
    expect(result!.error).toMatch(/did not rest/)
  })

  it('cancels by id', async () => {
    const boros = makerBoros()
    const fire = harness(boros)
    const result = await fire('cancel', { marketId: 11, tokenId: 1, orderIds: ['old-1'] })
    expect(result!.status).toBe('success')
    expect(boros.calls.at(-1)).toEqual({ cancel: ['old-1'] })
    expect(await boros.restingOrders()).toEqual([])
  })
})
