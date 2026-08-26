import { describe, it, expect } from 'vitest'
import { decideFill } from '../strategy/fill.js'
import type { FillParams, FillSnapshot } from '../strategy/fill.js'

/**
 * What happens after an accidental fill — the branch table, priced in real
 * money. A maker-reward strategy holds no view, so every one of these paths
 * exists to answer the same question in a different way: pay to be flat now,
 * or wait and risk paying more later.
 */

const params = (over: Partial<FillParams> = {}): FillParams => ({
  fillSlippage: 0.01,
  fillPolicy: 'limit',
  fillTimeoutMs: 600_000,
  fillStopDistance: 0.15,
  fillSlices: 4,
  fillSliceIntervalMs: 60_000,
  ...over,
})

/** Long 100 YU (closed by shorting), opened a minute ago at 6% mid. */
const snap = (over: Partial<FillSnapshot> = {}): FillSnapshot => ({
  outstanding: 100,
  closeSide: 'short',
  midApr: 0.06,
  now: 1_000_000,
  since: 1_000_000 - 60_000,
  entryApr: 0.06,
  sizeAtDetect: 100,
  slippage: 0.02,
  ...over,
})

const never = async () => 0

describe('decideFill', () => {
  it('crosses when the close lands inside the budget', async () => {
    const d = await decideFill(snap({ slippage: 0.004 }), params(), never)
    expect(d.action).toBe('cross')
    expect(d.reason).toMatch(/within the/)
  })

  it('rests when it does not', async () => {
    const d = await decideFill(snap({ slippage: 0.02 }), params(), never)
    expect(d).toMatchObject({ action: 'rest' })
  })

  /* Budget 0 is the old unconditional behaviour, kept reachable on purpose:
     someone who wants out at any price should not have to reason about a
     number to get it. */
  it('a zero budget means always cross', async () => {
    const d = await decideFill(snap({ slippage: 0.9 }), params({ fillSlippage: 0 }), never)
    expect(d).toMatchObject({ action: 'cross' })
  })

  // ── the two overrides ───────────────────────────────────────────────────

  /* Waiting for a better price is a plan with no end, and an open position on
     a strategy that wants none is a risk that grows with the clock. */
  it('crosses on the timeout however dear it is', async () => {
    const d = await decideFill(
      snap({ slippage: 0.5, since: 1_000_000 - 700_000 }),
      params({ fillPolicy: 'hold' }),
      never,
    )
    expect(d.action).toBe('cross')
    expect(d.reason).toMatch(/open for 700s/)
  })

  it('crosses when mid has moved against the position', async () => {
    // Long, closed by selling: it gets worse as mid FALLS. 6% → 5% is −16.7%.
    const d = await decideFill(snap({ slippage: 0.5, midApr: 0.05 }), params({ fillPolicy: 'hold' }), never)
    expect(d.action).toBe('cross')
    expect(d.reason).toMatch(/against the position/)
  })

  /* The mirror image, and the reason the sign is defined by which way we must
     TRADE rather than by which leg earns what: a short is closed by lifting
     the ask, so it worsens as mid rises. */
  it('reads the adverse direction from the closing side, not the sign of a P&L', async () => {
    const rising = { midApr: 0.07, slippage: 0.5 }
    expect((await decideFill(snap({ ...rising, closeSide: 'long' }), params(), never)).action).toBe('cross')
    // Same move, opposite position: for a long, mid rising is FAVOURABLE
    expect((await decideFill(snap({ ...rising, closeSide: 'short' }), params(), never)).action).toBe('rest')
  })

  /* A book too broken to quote is exactly when a stop matters most, so an
     unpriceable close must not short-circuit the overrides — only the
     cost-based branches. */
  it('still fires the overrides when the venue will not price the close', async () => {
    const blind = snap({ since: 0 })
    delete (blind as { slippage?: number }).slippage
    expect((await decideFill(blind, params(), never)).action).toBe('cross')
    // …and without an override, an unknown cost is a reason to wait, not to cross blind
    const calm = snap({ since: 1_000_000 - 1_000 })
    delete (calm as { slippage?: number }).slippage
    expect((await decideFill(calm, params(), never))).toMatchObject({ action: 'rest' })
  })

  it('honours 0 as off for both overrides', async () => {
    const d = await decideFill(
      snap({ slippage: 0.5, midApr: 0.01, since: 0 }),
      params({ fillStopDistance: 0, fillTimeoutMs: 0 }),
      never,
    )
    expect(d).toMatchObject({ action: 'rest' })
  })

  // ── policies ────────────────────────────────────────────────────────────

  it('hold keeps the position but still pulls our orders', async () => {
    const d = await decideFill(snap(), params({ fillPolicy: 'hold' }), never)
    // Not 'rest': resting would place a closing order, which is not holding
    expect(d).toMatchObject({ action: 'cancel-only' })
  })

  it('partial crosses only what the book absorbs within budget', async () => {
    const d = await decideFill(snap(), params({ fillPolicy: 'partial' }), async () => 40)
    expect(d).toMatchObject({ action: 'cross', maxSizeYu: 40 })
  })

  /* A slice too small to be worth its own relayed transaction is not a partial
     close, it is a fee. */
  it('partial rests rather than cross a sliver', async () => {
    const d = await decideFill(snap(), params({ fillPolicy: 'partial' }), async () => 1)
    expect(d).toMatchObject({ action: 'rest' })
  })

  it('ladder slices the size at detection, not the remainder', async () => {
    // 100 detected, 4 slices, 60 already worked off — the slice is still 25
    const d = await decideFill(snap({ outstanding: 40, sizeAtDetect: 100 }), params({ fillPolicy: 'ladder' }), never)
    expect(d).toMatchObject({ action: 'cross', maxSizeYu: 25, sliced: true })
  })

  it('ladder rests between slices', async () => {
    const d = await decideFill(
      snap({ lastSliceTs: 1_000_000 - 10_000 }),
      params({ fillPolicy: 'ladder' }),
      never,
    )
    expect(d).toMatchObject({ action: 'rest' })
  })

  /* Precedence is the whole safety argument: a policy is a preference, the
     overrides are limits, and a preference must never outrank a limit. */
  it('the overrides outrank every policy', async () => {
    for (const fillPolicy of ['limit', 'partial', 'ladder', 'hold'] as const) {
      const d = await decideFill(
        snap({ slippage: 0.9, since: 0 }),
        params({ fillPolicy }),
        async () => 50,
      )
      if (d.action !== 'cross') throw new Error(`policy ${fillPolicy}: expected cross, got ${d.action}`)
      expect(d.maxSizeYu, `policy: ${fillPolicy}`).toBeUndefined()   // forced = the whole thing
    }
  })
})
