import { describe, it, expect } from 'vitest'
import { makerPreset } from '../strategy/MakerStrategy.js'
import type { MarketPlan } from '@openwhaleorg/pendle'

/**
 * A scanned market as a card: the market and a size BOTH sides fit, the
 * figures the ranking was made from, and the flags that qualify them.
 */

const plan = (over: Partial<MarketPlan> = {}): MarketPlan => ({
  marketId: 101, symbol: 'BINANCE-ETHUSDT-25SEP2026', collateral: 'USDT', collateralUsd: 1, isolatedOnly: false,
  daysToMaturity: 22, midApr: 0.062,
  sides: [
    { side: 'long', budgetPerHour: 2, poolYu: 5_000, range: 0.005, edgeApr: 0.0573, marginPerYu: 0.01, sizeYu: 400, share: 0.074, capPerYu: 0.001, uncappedRewardPerHour: 0.148, rewardPerHour: 0.148 },
    { side: 'short', budgetPerHour: 2, poolYu: 8_000, range: 0.005, edgeApr: 0.0668, marginPerYu: 0.012, sizeYu: 333, share: 0.04, capPerYu: 0.001, uncappedRewardPerHour: 0.08, rewardPerHour: 0.08 },
  ],
  rewardPerHour: 0.228, usdPerDay: 5.47, usdToMaturity: 120.4, aprOnCapital: 1.997, capped: false, capUnknown: false, ...over,
})

describe('makerPreset', () => {
  it('sets the market and the smaller side\'s size, so both sides fit the capital', () => {
    const p = makerPreset(plan(), 1.0)
    expect(p.base).toEqual({ market: 'BINANCE-ETHUSDT-25SEP2026', marginMode: 'auto' })
    expect(p.tunable).toEqual({ sizeMode: 'fixed', sizeYu: 333 })
    expect(p.card?.headline).toEqual({ label: 'APR on $1k', value: '199.7%', tone: 'positive' })
    expect(p.card?.group).toBe('Two weeks or more')
    expect(p.card?.badges).toEqual([])
  })

  it('flags the ceiling, a missing ceiling, isolation and a near maturity', () => {
    const p = makerPreset(plan({ capped: true, capUnknown: true, isolatedOnly: true, daysToMaturity: 3 }), 1.0)
    expect(p.card?.badges?.map(b => b.text)).toEqual(['at ceiling', 'no ceiling published', 'isolated', '3d left'])
    expect(p.card?.headline?.tone).toBe('muted')
    expect(p.card?.group).toBe('Maturing soon')
  })
})
