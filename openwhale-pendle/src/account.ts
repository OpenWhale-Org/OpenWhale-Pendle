import { OwAccount } from '@openwhaleorg/core'
import { BOROS_LOGO } from './brand.js'
import type { BorosSession, BorosOpenOrder, BorosMarketQuote, BorosMarginMode, BorosSide } from './session.js'

/**
 * Read-only view of a Boros account — the 'pendle/rates' kind's canonical
 * Reader. v0 surfaces what needs no API signing key: entered markets, per-
 * market positions via contract reads, the USD gas balance (the requote
 * loop's fuel gauge), and the agent approval's expiry.
 */
/** USD value of a collateral amount: the venue's price when it has one, 1:1 for a stable it does not price. */
function valueUsd(tokenId: number, symbol: string, amount: number, prices: Map<number, number>): number | undefined {
  const price = prices.get(tokenId)
  if (price !== undefined) return amount * price
  return /USD/i.test(symbol) ? amount : undefined
}

@OwAccount({
  id: 'boros-account', kind: 'pendle/rates', venue: 'boros', displayName: 'Boros Account', logo: BOROS_LOGO,
  // What the Accounts page shows for a Boros account — declared here, rendered
  // generically: rate positions and orders are not perp rows and should not
  // be squeezed into Symbol / Side / Value / uPnL.
  sections: [
    {
      method: 'positions', title: 'Positions', kind: 'table', count: true, default: true, empty: 'No open positions.',
      columns: [
        { key: 'symbol', label: 'Market', format: 'mono', grow: true },
        { key: 'mode', label: 'Margin', format: 'badge' },
        { key: 'side', label: 'Side', format: 'side' },
        { key: 'sizeYu', label: 'Size (YU)', format: 'number', digits: 2, align: 'right' },
        { key: 'fixedAprPct', label: 'Fixed APR', format: 'pct', digits: 2, align: 'right' },
        { key: 'unrealisedPnl', label: 'Unrealised', format: 'signed', digits: 2, align: 'right' },
        { key: 'settlementPnl', label: 'Settlement', format: 'signed', digits: 2, align: 'right' },
        { key: 'cumulativePnl', label: 'Cumulative', format: 'signed', digits: 2, align: 'right' },
      ],
    },
    {
      method: 'orders', title: 'Open Orders', kind: 'table', count: true, empty: 'No open orders.',
      columns: [
        { key: 'symbol', label: 'Market', format: 'mono', grow: true },
        { key: 'mode', label: 'Margin', format: 'badge' },
        { key: 'side', label: 'Side', format: 'side' },
        { key: 'aprPct', label: 'APR', format: 'pct', digits: 2, align: 'right' },
        { key: 'sizeYu', label: 'Size (YU)', format: 'number', digits: 0, align: 'right' },
        { key: 'unfilledYu', label: 'Unfilled', format: 'number', digits: 0, align: 'right' },
        { key: 'placedAt', label: 'Placed', format: 'time' },
        { key: 'shortId', label: 'Order', format: 'mono' },
      ],
    },
    {
      method: 'margin', title: 'Margin', kind: 'table', empty: 'No margin accounts with balance.',
      columns: [
        { key: 'account', label: 'Account', format: 'mono', grow: true },
        { key: 'token', label: 'Token', format: 'badge' },
        { key: 'netBalance', label: 'Net balance', format: 'number', digits: 2, align: 'right' },
        { key: 'totalCash', label: 'Cash', format: 'number', digits: 2, align: 'right' },
        { key: 'usdValue', label: 'USD', format: 'usd', align: 'right' },
      ],
    },
    {
      method: 'summary', title: 'Summary', kind: 'keyvalue',
      columns: [
        { key: 'subAccount', label: 'Sub-account id', format: 'number', digits: 0 },
        { key: 'equityUsd', label: 'Equity (USD)', format: 'usd' },
        { key: 'gasUsd', label: 'Gas balance', format: 'usd', digits: 2 },
        { key: 'agentExpiresAt', label: 'Agent expires', format: 'time' },
        { key: 'accounts', label: 'Margin accounts', format: 'number', digits: 0 },
      ],
    },
  ],
})
export class BorosRatesAccount {
  static readonly kind = 'pendle/rates' as const
  static readonly venueType = 'boros'

  constructor(
    readonly name: string,
    protected readonly session: BorosSession,
  ) {}

  /**
   * Balances per margin account, in the venue's own equity figure (netBalance
   * = cash + unrealised + settlement), valued in USD at the venue's own asset
   * prices (stables 1:1 when a price is missing). The USD gas balance rides along.
   */
  async balance(): Promise<{ usd: { available: number; total: number }; tokens: Array<{ token: string; free: number; locked: number; total: number; usdValue?: number }> }> {
    const [infos, symbols, prices, gas, markets] = await Promise.all([
      this.session.accountInfos(),
      this.session.assets(),
      this.session.assetPrices().catch(() => new Map<number, number>()),
      this.session.gasBalance().catch(() => undefined),
      this.session.listLiveMarkets().catch(() => []),
    ])
    const marketSymbol = new Map(markets.map(m => [m.marketId, m.symbol]))
    const tokens = infos
      .filter(a => Math.abs(a.netBalance) > 1e-9 || Math.abs(a.totalCash) > 1e-9)
      .map(a => {
        const sym = symbols.get(a.tokenId) ?? `token#${a.tokenId}`
        const usd = valueUsd(a.tokenId, sym, a.netBalance, prices)
        return {
          token: `${sym} · ${a.marketId !== undefined ? `isolated ${marketSymbol.get(a.marketId) ?? a.marketId}` : 'cross'}`,
          free: a.netBalance,
          locked: Math.max(0, a.totalCash - a.netBalance),
          total: a.netBalance,
          ...(usd !== undefined ? { usdValue: usd } : {}),
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
  async orders(): Promise<Array<{ id: string; shortId: string; side: 'long' | 'short'; value: number; status: 'open' | 'partial'; symbol: string; mode: 'cross' | 'isolated'; aprPct: number; sizeYu: number; unfilledYu: number; placedAt?: number }>> {
    const [orders, markets] = await Promise.all([this.session.openOrders(), this.session.listLiveMarkets().catch(() => [])])
    const symbol = new Map(markets.map(m => [m.marketId, m.symbol]))
    return orders.map(o => ({
      id: `${o.orderId.slice(0, 6)}… ${symbol.get(o.marketId) ?? o.marketId} · ${o.isCross ? 'cross' : 'isolated'} @ ${(o.apr * 100).toFixed(2)}%`,
      shortId: `${o.orderId.slice(0, 8)}…`,
      side: o.side,
      value: o.sizeYu,
      status: o.unfilledYu < o.sizeYu ? 'partial' as const : 'open' as const,
      symbol: symbol.get(o.marketId) ?? `market ${o.marketId}`,
      mode: o.isCross ? 'cross' as const : 'isolated' as const,
      aprPct: o.apr * 100,
      sizeYu: o.sizeYu,
      unfilledYu: o.unfilledYu,
      ...(o.placedAt !== undefined ? { placedAt: o.placedAt } : {}),
    }))
  }

  /** Margin accounts (cross per token, isolated per market) with the venue's own balances. */
  async margin(): Promise<Array<{ account: string; token: string; netBalance: number; totalCash: number; usdValue?: number }>> {
    const [infos, symbols, prices, markets] = await Promise.all([this.session.accountInfos(), this.session.assets(), this.session.assetPrices().catch(() => new Map<number, number>()), this.session.listLiveMarkets().catch(() => [])])
    const marketSymbol = new Map(markets.map(m => [m.marketId, m.symbol]))
    return infos
      .filter(a => Math.abs(a.netBalance) > 1e-9 || Math.abs(a.totalCash) > 1e-9)
      .map(a => {
        const token = symbols.get(a.tokenId) ?? `token#${a.tokenId}`
        const usd = valueUsd(a.tokenId, token, a.netBalance, prices)
        return {
          account: a.marketId !== undefined ? `isolated · ${marketSymbol.get(a.marketId) ?? a.marketId}` : 'cross',
          token,
          netBalance: a.netBalance,
          totalCash: a.totalCash,
          ...(usd !== undefined ? { usdValue: usd } : {}),
        }
      })
  }

  /** One-glance facts: equity, the relay fuel gauge, when the agent approval lapses. */
  async summary(): Promise<{ subAccount: number; equityUsd: number; gasUsd?: number; agentExpiresAt?: number; accounts: number }> {
    const [infos, symbols, prices, gas, expiry] = await Promise.all([
      this.session.accountInfos(),
      this.session.assets(),
      this.session.assetPrices().catch(() => new Map<number, number>()),
      this.session.gasBalance().catch(() => undefined),
      this.session.agentExpiry().catch(() => undefined),
    ])
    const equityUsd = infos.reduce((acc, a) => acc + (valueUsd(a.tokenId, symbols.get(a.tokenId) ?? '', a.netBalance, prices) ?? 0), 0)
    return {
      subAccount: this.session.accountId,
      equityUsd,
      ...(gas !== undefined ? { gasUsd: gas } : {}),
      ...(expiry !== undefined && expiry > 0 ? { agentExpiresAt: expiry * 1000 } : {}),
      accounts: infos.length,
    }
  }

  /** Equity sample for the runtime snapshotter — every margin account's net balance at the venue's USD price (gas excluded). */
  async snapshot(): Promise<{ equity: number }> {
    const [infos, symbols, prices] = await Promise.all([this.session.accountInfos(), this.session.assets(), this.session.assetPrices().catch(() => new Map<number, number>())])
    const equity = infos.reduce((acc, a) => acc + (valueUsd(a.tokenId, symbols.get(a.tokenId) ?? '', a.netBalance, prices) ?? 0), 0)
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

  /** What crossing to close this size would average, and how far past the touch that is. */
  closeCost(args: { marketId: number; side: BorosSide; sizeYu: number }): Promise<{ touch: number; actualRate: number; slippage: number }> {
    return this.session.closeCost(args)
  }

  /** Margin the venue asks per YU to rest at this rate (linear in size). */
  marginPerYu(args: { marketId: number; side: BorosSide; apr: number }): Promise<number> {
    return this.session.marginPerYu(args)
  }

  /** Equity of the one margin account these orders live in. */
  marginBalance(marketId: number, tokenId: number, mode: BorosMarginMode = 'cross'): Promise<number> {
    return this.session.marginBalance(marketId, tokenId, mode)
  }

  quote(marketId: number): Promise<BorosMarketQuote> {
    return this.session.marketQuote(marketId)
  }
}
