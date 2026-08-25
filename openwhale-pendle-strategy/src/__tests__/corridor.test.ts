import { describe, it, expect } from 'vitest'
import { judgeSide, edgeApr } from '../strategy/corridor.js'

const params = { edgeRatio: 0.95, safeDistanceRatio: 0.3 }
const mid = 0.07
const range = 0.004 // ±0.4%

describe('corridor', () => {
  it('rests just inside the far edge on each side', () => {
    expect(edgeApr(mid, range, 'long', params)).toBeCloseTo(0.07 - 0.0038, 9)
    expect(edgeApr(mid, range, 'short', params)).toBeCloseTo(0.07 + 0.0038, 9)
  })

  it('places when nothing rests', () => {
    expect(judgeSide({ side: 'long', mid, range, restingApr: undefined, params }).action).toBe('place')
  })

  it('keeps an order inside the corridor', () => {
    // long resting 0.3% below mid: inside [0.12%, 0.4%]
    expect(judgeSide({ side: 'long', mid, range, restingApr: 0.067, params }).action).toBe('keep')
    expect(judgeSide({ side: 'short', mid, range, restingApr: 0.073, params }).action).toBe('keep')
  })

  it('re-quotes when the order fell out of the band (mid moved away)', () => {
    // long resting 0.5% below mid → beyond the 0.4% band → not earning
    const v = judgeSide({ side: 'long', mid, range, restingApr: 0.065, params })
    expect(v.action).toBe('requote')
    expect(v.reason).toMatch(/out of band/)
  })

  it('re-quotes when mid crept too close (fill risk)', () => {
    // short resting 0.05% above mid → inside safety line (0.12%)
    const v = judgeSide({ side: 'short', mid, range, restingApr: 0.0705, params })
    expect(v.action).toBe('requote')
    expect(v.reason).toMatch(/too close/)
  })

  it('treats an order on the wrong side of mid as too close', () => {
    // a long order now ABOVE mid would be filled next tick
    expect(judgeSide({ side: 'long', mid, range, restingApr: 0.071, params }).action).toBe('requote')
  })
})
