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
