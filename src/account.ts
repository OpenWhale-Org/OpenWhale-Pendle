import { OwAccount } from '@openwhaleorg/core'
import type { BorosSession, BorosOpenOrder, BorosMarketQuote } from './session.js'

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

  /**
   * Balances per margin account, in the venue's own equity figure (netBalance
   * = cash + unrealised + settlement). Stable-token accounts value 1:1 USD;
   * other collateral is listed unvalued. The USD gas balance rides along.
   */
  async balance(): Promise<{ usd: { available: number; total: number }; tokens: Array<{ token: string; free: number; locked: number; total: number; usdValue?: number }> }> {
    const [infos, symbols, gas, markets] = await Promise.all([
      this.session.accountInfos(),
      this.session.assets(),
      this.session.gasBalance().catch(() => undefined),
      this.session.listLiveMarkets().catch(() => []),
    ])
    const marketSymbol = new Map(markets.map(m => [m.marketId, m.symbol]))
    const tokens = infos
      .filter(a => Math.abs(a.netBalance) > 1e-9 || Math.abs(a.totalCash) > 1e-9)
      .map(a => {
        const sym = symbols.get(a.tokenId) ?? `token#${a.tokenId}`
        const stable = /USD/i.test(sym)
        return {
          token: `${sym} · ${a.marketId !== undefined ? `isolated ${marketSymbol.get(a.marketId) ?? a.marketId}` : 'cross'}`,
          free: a.netBalance,
          locked: Math.max(0, a.totalCash - a.netBalance),
          total: a.netBalance,
          ...(stable ? { usdValue: a.netBalance } : {}),
        }
      })
    if (gas !== undefined) tokens.push({ token: 'GAS (USD)', free: gas, locked: 0, total: gas, usdValue: gas })
    const total = tokens.reduce((acc, t) => acc + (t.usdValue ?? 0), 0)
    return { usd: { available: total, total }, tokens }
  }

  /** Every open position, cross and isolated — what the venue UI shows. */
  async positions(): Promise<Array<{ symbol: string; mode: 'cross' | 'isolated'; side: 'long' | 'short'; sizeYu: number; fixedAprPct: number; unrealisedPnl: number; settlementPnl: number; cumulativePnl: number }>> {
    const [positions, markets] = await Promise.all([this.session.activePositions(), this.session.listLiveMarkets().catch(() => [])])
    const symbol = new Map(markets.map(m => [m.marketId, m.symbol]))
    return positions.map(p => ({
      symbol: symbol.get(p.marketId) ?? `market ${p.marketId}`,
      mode: p.isCross ? 'cross' as const : 'isolated' as const,
      side: p.signedSizeYu >= 0 ? 'long' as const : 'short' as const,
      sizeYu: Math.abs(p.signedSizeYu),
      fixedAprPct: p.fixedApr * 100,
      unrealisedPnl: p.unrealisedPnl,
      settlementPnl: p.settlementPnl,
      cumulativePnl: p.cumulativePnl,
    }))
  }

  /** Every open order, cross and isolated. */
  async orders(): Promise<Array<{ id: string; symbol: string; mode: 'cross' | 'isolated'; side: 'long' | 'short'; aprPct: number; sizeYu: number; unfilledYu: number }>> {
    const [orders, markets] = await Promise.all([this.session.openOrders(), this.session.listLiveMarkets().catch(() => [])])
    const symbol = new Map(markets.map(m => [m.marketId, m.symbol]))
    return orders.map(o => ({
      id: o.orderId,
      symbol: symbol.get(o.marketId) ?? `market ${o.marketId}`,
      mode: o.isCross ? 'cross' as const : 'isolated' as const,
      side: o.side,
      aprPct: o.apr * 100,
      sizeYu: o.sizeYu,
      unfilledYu: o.unfilledYu,
    }))
  }

  /** Equity sample for the runtime snapshotter — stable-collateral net balances (gas excluded). */
  async snapshot(): Promise<{ equity: number }> {
    const [infos, symbols] = await Promise.all([this.session.accountInfos(), this.session.assets()])
    const equity = infos.reduce((acc, a) => acc + (/USD/i.test(symbols.get(a.tokenId) ?? '') ? a.netBalance : 0), 0)
    return { equity }
  }

  /** Agent approval expiry (epoch seconds) — 0/past means trading is dead. */
  async agentExpiry(): Promise<number> {
    return this.session.agentExpiry()
  }

  /** Per-market reads a maker strategy lives on — the CROSS account only. */
  restingOrders(marketId: number, tokenId: number): Promise<BorosOpenOrder[]> {
    return this.session.restingOrders(marketId, tokenId)
  }

  crossPosition(marketId: number, tokenId: number): Promise<{ signedSizeYu: number; positionValue: number } | undefined> {
    return this.session.crossPosition(marketId, tokenId)
  }

  gasBalance(): Promise<number> {
    return this.session.gasBalance()
  }

  quote(marketId: number): Promise<BorosMarketQuote> {
    return this.session.marketQuote(marketId)
  }
}
