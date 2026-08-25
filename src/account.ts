import { OwAccount } from '@openwhaleorg/core'
import type { BorosSession, BorosOpenOrder, BorosPosition, BorosMarketQuote } from './session.js'

/**
 * Read-only view of a Boros account — the 'pendle/rates' kind's canonical
 * Reader. v0 surfaces what needs no API signing key: entered markets, per-
 * market positions via contract reads, the USD gas balance (the requote
 * loop's fuel gauge), and the agent approval's expiry.
 */
@OwAccount({ id: 'boros-account', kind: 'pendle/rates', venue: 'boros', displayName: 'Boros Account' })
export class BorosRatesAccount {
  static readonly kind = 'pendle/rates' as const
  static readonly venueType = 'boros'

  constructor(
    readonly name: string,
    protected readonly session: BorosSession,
  ) {}

  async balance(): Promise<{ usd: { available: number; total: number }; tokens: Array<{ token: string; free: number; locked: number; total: number; usdValue?: number }> }> {
    const gas = await this.session.gasBalance()
    return {
      usd: { available: gas, total: gas },
      tokens: [{ token: 'GAS (USD)', free: gas, locked: 0, total: gas, usdValue: gas }],
    }
  }

  async positions(): Promise<Array<{ marketId: number; symbol: string; signedSizeYu: number; positionValue: number }>> {
    const markets = await this.session.listLiveMarkets()
    const byId = new Map(markets.map(m => [m.marketId, m]))
    // Entry is per collateral token: ask once per tokenId the venue lists
    const tokenIds = Array.from(new Set(markets.map(m => m.tokenId)))
    const out: Array<{ marketId: number; symbol: string; signedSizeYu: number; positionValue: number }> = []
    for (const tokenId of tokenIds) {
      let entered: readonly number[] = []
      try {
        entered = await this.session.enteredMarkets(tokenId)
      } catch { continue }
      for (const marketId of entered) {
        const market = byId.get(marketId)
        if (!market) continue
        try {
          const p = await this.session.position(marketId, tokenId)
          if (p && Math.abs(p.signedSizeYu) > 0) out.push({ marketId, symbol: market.symbol, signedSizeYu: p.signedSizeYu, positionValue: p.positionValue })
        } catch { /* per-market read failures stay per-market */ }
      }
    }
    return out
  }

  /** Agent approval expiry (epoch seconds) — 0/past means trading is dead. */
  async agentExpiry(): Promise<number> {
    return this.session.agentExpiry()
  }

  /** Per-market reads a maker strategy lives on. */
  openOrders(marketId: number, tokenId: number): Promise<BorosOpenOrder[]> {
    return this.session.openOrders(marketId, tokenId)
  }

  position(marketId: number, tokenId: number): Promise<BorosPosition | undefined> {
    return this.session.position(marketId, tokenId)
  }

  gasBalance(): Promise<number> {
    return this.session.gasBalance()
  }

  quote(marketId: number): Promise<BorosMarketQuote> {
    return this.session.marketQuote(marketId)
  }
}
