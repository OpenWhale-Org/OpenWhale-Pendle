import { OwAccount } from '@openwhaleorg/core'
import type { BorosSession, BorosOpenOrder, BorosMarketQuote, BorosMarginMode } from './session.js'

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

  /**
   * Every open position, cross and isolated — what the venue UI shows. Rows
   * follow the dashboard's position convention ({ id, side, value, pnl })
   * with the rate-specific facts alongside.
   */
  async positions(): Promise<Array<{ id: string; side: 'long' | 'short'; value: number; pnl: number; symbol: string; mode: 'cross' | 'isolated'; sizeYu: number; fixedAprPct: number; unrealisedPnl: number; settlementPnl: number }>> {
    const [positions, markets] = await Promise.all([this.session.activePositions(), this.session.listLiveMarkets().catch(() => [])])
    const symbol = new Map(markets.map(m => [m.marketId, m.symbol]))
    return positions.map(p => {
      const sym = symbol.get(p.marketId) ?? `market ${p.marketId}`
      const mode = p.isCross ? 'cross' as const : 'isolated' as const
      return {
        id: `${sym} · ${mode} @ ${(p.fixedApr * 100).toFixed(2)}%`,
        side: p.signedSizeYu >= 0 ? 'long' as const : 'short' as const,
        value: Math.abs(p.signedSizeYu),
        pnl: p.unrealisedPnl + p.settlementPnl,
        symbol: sym,
        mode,
        sizeYu: Math.abs(p.signedSizeYu),
        fixedAprPct: p.fixedApr * 100,
        unrealisedPnl: p.unrealisedPnl,
        settlementPnl: p.settlementPnl,
      }
    })
  }

  /** Every open order, cross and isolated — dashboard convention { id, side, value, status } plus rate facts. */
  async orders(): Promise<Array<{ id: string; side: 'long' | 'short'; value: number; status: 'open' | 'partial'; symbol: string; mode: 'cross' | 'isolated'; aprPct: number; sizeYu: number; unfilledYu: number }>> {
    const [orders, markets] = await Promise.all([this.session.openOrders(), this.session.listLiveMarkets().catch(() => [])])
    const symbol = new Map(markets.map(m => [m.marketId, m.symbol]))
    return orders.map(o => ({
      id: `${o.orderId.slice(0, 6)}… ${symbol.get(o.marketId) ?? o.marketId} · ${o.isCross ? 'cross' : 'isolated'} @ ${(o.apr * 100).toFixed(2)}%`,
      side: o.side,
      value: o.sizeYu,
      status: o.unfilledYu < o.sizeYu ? 'partial' as const : 'open' as const,
      symbol: symbol.get(o.marketId) ?? `market ${o.marketId}`,
      mode: o.isCross ? 'cross' as const : 'isolated' as const,
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
  restingOrders(marketId: number, tokenId: number, mode: BorosMarginMode = 'cross'): Promise<BorosOpenOrder[]> {
    return this.session.restingOrders(marketId, tokenId, mode)
  }

  crossPosition(marketId: number, tokenId: number, mode: BorosMarginMode = 'cross'): Promise<{ signedSizeYu: number; positionValue: number } | undefined> {
    return this.session.crossPosition(marketId, tokenId, mode)
  }

  gasBalance(): Promise<number> {
    return this.session.gasBalance()
  }

  quote(marketId: number): Promise<BorosMarketQuote> {
    return this.session.marketQuote(marketId)
  }
}
