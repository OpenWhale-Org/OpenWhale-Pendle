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
  id: 'boros-account', kind: 'pendle/rates', venue: 'boros', displayName: { en: 'Boros Account', 'zh-CN': 'Boros 账户' }, logo: BOROS_LOGO,
  // What the Accounts page shows for a Boros account — declared here, rendered
  // generically: rate positions and orders are not perp rows and should not
  // be squeezed into Symbol / Side / Value / uPnL.
  sections: [
    {
      method: 'positions', title: { en: 'Positions', 'zh-CN': '持仓' }, kind: 'table', count: true, default: true, empty: 'No open positions.',
      columns: [
        { key: 'symbol', label: { en: 'Market', 'zh-CN': '市场' }, format: 'mono', grow: true },
        { key: 'mode', label: { en: 'Margin', 'zh-CN': '保证金' }, format: 'badge' },
        { key: 'side', label: { en: 'Side', 'zh-CN': '方向' }, format: 'side' },
        { key: 'sizeYu', label: { en: 'Size (YU)', 'zh-CN': '规模（YU）' }, format: 'number', digits: 2, align: 'right' },
        { key: 'fixedAprPct', label: { en: 'Fixed APR', 'zh-CN': '固定年化' }, format: 'pct', digits: 2, align: 'right' },
        { key: 'unrealisedPnl', label: { en: 'Unrealised', 'zh-CN': '未实现' }, format: 'signed', digits: 2, align: 'right' },
        { key: 'settlementPnl', label: { en: 'Settlement', 'zh-CN': '结算' }, format: 'signed', digits: 2, align: 'right' },
        { key: 'cumulativePnl', label: { en: 'Cumulative', 'zh-CN': '累计' }, format: 'signed', digits: 2, align: 'right' },
      ],
    },
    {
      method: 'orders', title: { en: 'Open Orders', 'zh-CN': '挂单' }, kind: 'table', count: true, empty: 'No open orders.',
      columns: [
        { key: 'symbol', label: { en: 'Market', 'zh-CN': '市场' }, format: 'mono', grow: true },
        { key: 'mode', label: { en: 'Margin', 'zh-CN': '保证金' }, format: 'badge' },
        { key: 'side', label: { en: 'Side', 'zh-CN': '方向' }, format: 'side' },
        { key: 'aprPct', label: 'APR', format: 'pct', digits: 2, align: 'right' },
        { key: 'sizeYu', label: { en: 'Size (YU)', 'zh-CN': '规模（YU）' }, format: 'number', digits: 0, align: 'right' },
        { key: 'unfilledYu', label: { en: 'Unfilled', 'zh-CN': '未成交' }, format: 'number', digits: 0, align: 'right' },
        { key: 'placedAt', label: { en: 'Placed', 'zh-CN': '下单时间' }, format: 'time' },
        { key: 'shortId', label: { en: 'Order', 'zh-CN': '订单' }, format: 'mono' },
      ],
    },
    {
      method: 'margin', title: { en: 'Margin', 'zh-CN': '保证金' }, kind: 'table', empty: 'No margin accounts with balance.',
      columns: [
        { key: 'account', label: { en: 'Account', 'zh-CN': '账户' }, format: 'mono', grow: true },
        { key: 'token', label: { en: 'Token', 'zh-CN': '代币' }, format: 'badge' },
        { key: 'netBalance', label: { en: 'Net balance', 'zh-CN': '净余额' }, format: 'number', digits: 2, align: 'right' },
        { key: 'totalCash', label: { en: 'Cash', 'zh-CN': '现金' }, format: 'number', digits: 2, align: 'right' },
        { key: 'usdValue', label: 'USD', format: 'usd', align: 'right' },
      ],
    },
    {
      method: 'summary', title: { en: 'Summary', 'zh-CN': '概览' }, kind: 'keyvalue',
      columns: [
        { key: 'subAccount', label: { en: 'Sub-account id', 'zh-CN': '子账户 id' }, format: 'number', digits: 0 },
        { key: 'equityUsd', label: { en: 'Equity (USD)', 'zh-CN': '权益（USD）' }, format: 'usd' },
        { key: 'gasUsd', label: { en: 'Gas balance', 'zh-CN': 'Gas 余额' }, format: 'usd', digits: 2 },
        { key: 'agentExpiresAt', label: { en: 'Agent expires', 'zh-CN': '代理到期' }, format: 'time' },
        { key: 'accounts', label: { en: 'Margin accounts', 'zh-CN': '保证金账户' }, format: 'number', digits: 0 },
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
