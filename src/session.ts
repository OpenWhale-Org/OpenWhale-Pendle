import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'
import { Agent, Exchange, getOpenApiSdk, MarketAccLib, CROSS_MARKET_ID, Side, TimeInForce } from '@pendle/boros-sdk-public'

const DEFAULT_RPC = 'https://arb1.arbitrum.io/rpc'

export interface BorosSessionOptions {
  /** Absent = keyless: public market data only. */
  agentPrivateKey?: string
  rootAddress?: `0x${string}`
  accountId?: number
  rpcUrl?: string
}

export interface MakerCampaignSide {
  incentiveRange: number
  budgetPerHour: number
  currentInRangeLiquidity: string
  currentCappedDistributionPerHour?: number
  currentEligibleShare?: number
  accumulatedReward?: number
}

export interface MakerCampaign {
  epochTimestamp: number
  addLiquidityIncentive?: { long?: MakerCampaignSide; short?: MakerCampaignSide }
  filledVolumeIncentive?: { userMakerVolume: number; totalMakerVolume: number; totalEpochReward: number; avgRewardPerYu: number }
  makerFeeRebate?: { feeShareRate: number }
}

export interface BorosMarketSummary {
  marketId: number
  symbol: string
  tokenId: number
  maturity: number
  platform: string
  /** The venue refuses cross-margin orders here — isolated is the only option. */
  isolatedOnly: boolean
}

export type BorosSide = 'long' | 'short'
/** Which margin account an order/position lives in: the token's cross account, or the market's isolated one. */
export type BorosMarginMode = 'cross' | 'isolated'

/** A market's live rate picture — APRs as decimals (0.068 = 6.8%). */
export interface BorosMarketQuote {
  marketId: number
  midApr: number
  markApr: number
  bestBid?: number
  bestAsk?: number
  lastTradedApr: number
  nextSettlementTime: number
  timeToMaturity: number
}

export interface BorosBookLevel { apr: number; sizeYu: number }
export interface BorosBook { long: BorosBookLevel[]; short: BorosBookLevel[]; blockNumber: number }

export interface BorosOpenOrder {
  orderId: string
  marketId: number
  side: BorosSide
  /** Implied APR the order rests at (decimal). */
  apr: number
  sizeYu: number
  unfilledYu: number
  /** Cross-margin account (the strategy's) vs an isolated per-market account (manual UI trades). */
  isCross: boolean
}

export interface BorosPosition {
  marketId: number
  tokenId: number
  isCross: boolean
  /** Long positive, short negative — YU. */
  signedSizeYu: number
  /** Entry fixed APR (decimal). */
  fixedApr: number
  unrealisedPnl: number
  settlementPnl: number
  cumulativePnl: number
}

/** One margin account (cross per token, or isolated per market) with its balances. */
export interface BorosAccountInfo {
  marketAcc: string
  tokenId: number
  /** undefined = cross account for the token. */
  marketId?: number
  netBalance: number
  totalCash: number
}

const YU = 1e18
const toYu = (raw: bigint | string): number => Number(BigInt(raw)) / YU
const fromYu = (yu: number): bigint => BigInt(Math.round(yu * YU))

function normalizeKey(key: string): `0x${string}` {
  return (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`
}

/**
 * The SDK surfaces HTTP failures as bare axios errors ("Request failed with
 * status code 400") — the venue's actual reason lives in the response body.
 * Re-throw with it attached so executions record why.
 */
async function withVenueError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const e = err as { response?: { status?: number; data?: unknown }; message?: string }
    if (e?.response) {
      const body = typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data)
      throw new Error(`Boros API ${e.response.status ?? ''}: ${body?.slice(0, 600)}`)
    }
    throw err
  }
}

/**
 * The (boros/rates, boros) cell's session. Trading actions are signed by the
 * AGENT key and relayed by Boros's Send Txs Bot (gas debited from the
 * account's on-chain USD gas balance) — the root wallet's private key never
 * enters this class. Keyless sessions carry only the public Open API surface.
 */
export class BorosSession {
  readonly api = getOpenApiSdk()
  readonly exchange?: Exchange
  readonly rootAddress?: `0x${string}`
  readonly accountId: number

  constructor(options: BorosSessionOptions = {}) {
    this.accountId = options.accountId ?? 0
    if (options.agentPrivateKey && options.rootAddress) {
      const agent = Agent.createFromPrivateKey(normalizeKey(options.agentPrivateKey))
      // The wallet client satisfies the Exchange constructor; sensitive paths
      // (deposit/withdraw) need the ROOT key and are simply not reachable
      // through this session — they stay a manual, operator-run concern.
      const walletClient = createWalletClient({
        account: privateKeyToAccount(normalizeKey(options.agentPrivateKey)),
        chain: arbitrum,
        transport: http(options.rpcUrl ?? DEFAULT_RPC),
      })
      this.rootAddress = options.rootAddress
      this.exchange = new Exchange(walletClient, options.rootAddress, this.accountId, [options.rpcUrl ?? DEFAULT_RPC], agent)
    }
  }

  private requireExchange(): Exchange {
    if (!this.exchange) throw new Error('This Boros session is keyless — bind a boros/agent credential to trade or read the account')
    return this.exchange
  }

  // ── Public data (keyless-capable) ──────────────────────────────────────────

  async listLiveMarkets(): Promise<BorosMarketSummary[]> {
    const res = (await this.api.markets.marketsControllerListMarkets({ isMatured: false, isUiWhitelisted: true, limit: 100 })).data as unknown as {
      results?: Array<Record<string, unknown>>
    }
    const rows = (res.results ?? []) as unknown as Array<{
      marketId: number
      tokenId: number
      imData: { symbol: string; maturity: number; isIsolatedOnly?: boolean }
      metadata?: { fundingRateSymbol?: string }
      platform?: unknown
    }>
    return rows.map(m => ({
      marketId: m.marketId,
      symbol: m.imData.symbol,
      tokenId: m.tokenId,
      maturity: m.imData.maturity,
      platform: m.imData.symbol.split('-')[0] ?? String(m.platform ?? ''),
      isolatedOnly: m.imData.isIsolatedOnly === true,
    }))
  }

  /**
   * Market catalogue in the dashboard picker's shape (duck-typed
   * fetchMarkets(), like exchange venues). One row per live whitelisted
   * market; `symbol` is Boros's own market symbol and doubles as the
   * strategy/monitor key.
   */
  async fetchMarkets(): Promise<Array<{ symbol: string; base: string; quote: string; type: 'swap'; active: boolean; marketId: number; tokenId: number; maturity: number }>> {
    const markets = await this.listLiveMarkets()
    return markets.map(m => ({
      symbol: m.symbol,
      base: m.symbol.split('-')[1] ?? m.symbol,
      quote: m.platform,
      type: 'swap' as const,
      active: true,
      marketId: m.marketId,
      tokenId: m.tokenId,
      maturity: m.maturity,
      isolatedOnly: m.isolatedOnly,
    }))
  }

  async makerCampaign(marketId: number): Promise<MakerCampaign> {
    return (await this.api.miscellaneous.incentivesControllerGetMakerIncentiveCampaign(marketId)).data as MakerCampaign
  }

  /** Order book at the given tick size — `ia` integers × tickSize = APR decimal. */
  async orderBook(marketId: number, tickSize: 0.0001 | 0.001 | 0.01 | 0.1 = 0.001): Promise<BorosBook> {
    const raw = (await this.api.markets.marketsControllerGetOrderBook({ marketId, tickSize })).data
    const side = (s: { ia: number[]; sz: string[] }): BorosBookLevel[] =>
      s.ia.map((tick, i) => ({ apr: tick * tickSize, sizeYu: toYu(s.sz[i] ?? '0') }))
    return { long: side(raw.long), short: side(raw.short), blockNumber: raw.syncStatus?.blockNumber ?? 0 }
  }

  /** Live mid/mark/best APRs for one market (keyless — the public markets endpoint). */
  async marketQuote(marketId: number): Promise<BorosMarketQuote> {
    const res = (await this.api.markets.marketsControllerGetMarketsByIds({ marketIds: String(marketId) })).data as unknown as {
      results?: Array<{ marketId: number; data?: Record<string, number> }>
    }
    const m = (res.results ?? []).find(r => r.marketId === marketId)
    if (!m?.data) throw new Error(`Boros market ${marketId} not found`)
    const d = m.data
    return {
      marketId,
      midApr: d['midApr'] ?? d['markApr'] ?? 0,
      markApr: d['markApr'] ?? 0,
      ...(d['bestBid'] !== undefined ? { bestBid: d['bestBid'] } : {}),
      ...(d['bestAsk'] !== undefined ? { bestAsk: d['bestAsk'] } : {}),
      lastTradedApr: d['lastTradedApr'] ?? 0,
      nextSettlementTime: d['nextSettlementTime'] ?? 0,
      timeToMaturity: d['timeToMaturity'] ?? 0,
    }
  }

  // ── Account reads (credentialed; REST, no signing key needed) ──────────────

  private requireRoot(): `0x${string}` {
    if (!this.rootAddress) throw new Error('This Boros session is keyless — bind a pendle/boros-agent credential to read the account')
    return this.rootAddress
  }

  private assetSymbols?: Map<number, string>
  /** tokenId → collateral symbol, cached for the session. */
  async assets(): Promise<Map<number, string>> {
    if (this.assetSymbols) return this.assetSymbols
    const res = (await this.api.assets.assetsControllerListAssets({})).data as unknown as { results?: Array<{ tokenId: number; symbol?: string; name?: string }> }
    this.assetSymbols = new Map((res.results ?? []).map(a => [a.tokenId, a.symbol ?? a.name ?? String(a.tokenId)]))
    return this.assetSymbols
  }

  async gasBalance(): Promise<number> {
    return this.requireExchange().getGasBalance()
  }

  /** Every open position of the root account — cross and isolated alike. */
  async activePositions(): Promise<BorosPosition[]> {
    const root = this.requireRoot()
    const res = (await this.api.accounts.accountsV2ControllerGetActivePositions({ root, accountId: this.accountId })).data as unknown as {
      results?: Array<{ marketId: number; marketAcc: string; isCross: boolean; fixedApr: number; signedSize: string; cumulativePnl: string; unrealisedPnl?: string; settlementPnl?: string }>
    }
    return (res.results ?? []).map(p => ({
      marketId: p.marketId,
      tokenId: MarketAccLib.unpack(p.marketAcc as `0x${string}`).tokenId,
      isCross: p.isCross,
      signedSizeYu: toYu(p.signedSize),
      fixedApr: p.fixedApr,
      unrealisedPnl: toYu(p.unrealisedPnl ?? '0'),
      settlementPnl: toYu(p.settlementPnl ?? '0'),
      cumulativePnl: toYu(p.cumulativePnl),
    }))
  }

  /** Open orders of the root account (all markets unless one is given) — cross and isolated alike. */
  async openOrders(marketId?: number): Promise<BorosOpenOrder[]> {
    const root = this.requireRoot()
    const res = (await this.api.accounts.accountsV2ControllerGetOrders({
      root, accountId: this.accountId, isActive: true, limit: 50, ...(marketId !== undefined ? { marketId } : {}),
    })).data as unknown as {
      results?: Array<{ orderId: string; marketId: number; side: 0 | 1; impliedApr: number; placedSize: string; unfilledSize: string; isCross: boolean }>
    }
    return (res.results ?? []).map(o => ({
      orderId: o.orderId,
      marketId: o.marketId,
      side: o.side === 0 ? 'long' : 'short',
      apr: o.impliedApr,
      sizeYu: toYu(o.placedSize),
      unfilledYu: toYu(o.unfilledSize),
      isCross: o.isCross,
    }))
  }

  /** Margin accounts with balances — netBalance is the venue's own equity figure per account. */
  async accountInfos(): Promise<BorosAccountInfo[]> {
    const root = this.requireRoot()
    const res = (await this.api.accounts.accountsV2ControllerGetMarketAccInfosByRoot({ root })).data as unknown as {
      results?: Array<{ marketAcc: string; totalCash: string; netBalance: string }>
    }
    return (res.results ?? []).map(a => {
      const { tokenId, marketId } = MarketAccLib.unpack(a.marketAcc as `0x${string}`)
      return {
        marketAcc: a.marketAcc,
        tokenId,
        ...(marketId !== CROSS_MARKET_ID ? { marketId } : {}),
        netBalance: toYu(a.netBalance),
        totalCash: toYu(a.totalCash),
      }
    })
  }

  async positions(marketId: number, tokenId: number): Promise<unknown> {
    return this.requireExchange().getUserPositions({ marketId, tokenId })
  }

  /**
   * Markets this account has entered under one collateral token — the
   * contract keys entry by the cross-margin MarketAcc (root + sub-account +
   * tokenId), so the question is per collateral, never per address.
   */
  async enteredMarkets(tokenId: number): Promise<readonly number[]> {
    return this.requireExchange().getEnteredMarkets(this.marketAcc(tokenId))
  }

  async agentExpiry(): Promise<number> {
    return this.requireExchange().getAgentExpiryTime()
  }

  /** The margin account for (token, mode): cross packs the CROSS sentinel, isolated packs the market id. */
  private marketAcc(tokenId: number, mode: BorosMarginMode = 'cross', marketId?: number): `0x${string}` {
    this.requireExchange()
    if (mode === 'isolated' && marketId === undefined) throw new Error('isolated marketAcc needs the marketId')
    return MarketAccLib.pack(this.rootAddress!, this.accountId, tokenId, mode === 'isolated' ? marketId! : CROSS_MARKET_ID) as `0x${string}`
  }

  /** Cross-margin entry into a market is a one-time on-chain step; idempotent here. */
  async ensureEntered(marketId: number, tokenId: number, mode: BorosMarginMode = 'cross'): Promise<void> {
    if (mode === 'isolated') return   // isolated accounts have no entry step
    const entered = await this.enteredMarkets(tokenId)
    if (entered.includes(marketId)) return
    await withVenueError(() => this.requireExchange().enterMarkets(true, [marketId]))
  }

  /**
   * The strategy's resting orders on a market: CROSS account only, straight
   * from the contract. Isolated orders belong to whoever placed them by hand
   * on the venue UI and are never touched by automation.
   */
  async restingOrders(marketId: number, tokenId: number, mode: BorosMarginMode = 'cross'): Promise<BorosOpenOrder[]> {
    const own = this.marketAcc(tokenId, mode, marketId).toLowerCase()
    const { results } = await this.requireExchange().getActiveOrdersFromContract({ marketId, tokenId })
    return results
      .filter(o => o.marketAcc.toLowerCase() === own)
      .map(o => ({
        orderId: o.orderId.toString(),
        marketId,
        side: o.side === Side.LONG ? 'long' : 'short',
        apr: o.impliedApr,
        sizeYu: toYu(o.size),
        unfilledYu: toYu(o.unfilledSize),
        isCross: mode === 'cross',
      }))
  }

  /** The strategy's position on a market — CROSS account only (see restingOrders). */
  async crossPosition(marketId: number, tokenId: number, mode: BorosMarginMode = 'cross'): Promise<{ signedSizeYu: number; positionValue: number } | undefined> {
    const own = this.marketAcc(tokenId, mode, marketId).toLowerCase()
    const positions = await this.requireExchange().getUserPositions({ marketId, tokenId })
    const p = positions.find(x => x.marketId === marketId && x.marketAcc.toLowerCase() === own)
    if (!p) return undefined
    return { signedSizeYu: toYu(p.signedSize), positionValue: toYu(p.positionValue) }
  }

  // ── Writes (agent-signed, relayed) ─────────────────────────────────────────

  /**
   * Post-only resting order at an APR: ADD_LIQUIDITY_ONLY is rejected rather
   * than crossed, so a maker-reward order can never accidentally take.
   */
  async placeMakerOrder(args: { marketId: number; tokenId: number; side: BorosSide; sizeYu: number; apr: number; mode?: BorosMarginMode }): Promise<Record<string, unknown>> {
    const result = await withVenueError(() => this.requireExchange().placeOrder({
      marketAcc: this.marketAcc(args.tokenId, args.mode ?? 'cross', args.marketId),
      marketId: args.marketId,
      side: args.side === 'long' ? Side.LONG : Side.SHORT,
      size: fromYu(args.sizeYu),
      rate: args.apr,
      // The calldata builder insists on exactly one of slippage/desiredRate even
      // for a resting limit; 0 slippage is the honest value for a post-only order
      slippage: 0,
      tif: TimeInForce.ADD_LIQUIDITY_ONLY,
    }))
    return result as unknown as Record<string, unknown>
  }

  /** Immediate-or-cancel order at an aggressive APR — the flatten path after an accidental fill. */
  async takerOrder(args: { marketId: number; tokenId: number; side: BorosSide; sizeYu: number; apr: number; mode?: BorosMarginMode }): Promise<Record<string, unknown>> {
    const result = await withVenueError(() => this.requireExchange().placeOrder({
      marketAcc: this.marketAcc(args.tokenId, args.mode ?? 'cross', args.marketId),
      marketId: args.marketId,
      side: args.side === 'long' ? Side.LONG : Side.SHORT,
      size: fromYu(args.sizeYu),
      rate: args.apr,
      slippage: 0,
      tif: TimeInForce.IMMEDIATE_OR_CANCEL,
    }))
    return result as unknown as Record<string, unknown>
  }

  async cancelOrders(marketId: number, tokenId: number, orderIds: string[], mode: BorosMarginMode = 'cross'): Promise<void> {
    if (orderIds.length === 0) return
    await withVenueError(() => this.requireExchange().cancelOrders({ marketAcc: this.marketAcc(tokenId, mode, marketId), marketId, cancelAll: false, orderIds }))
  }

  async cancelAll(marketId: number, tokenId: number, mode: BorosMarginMode = 'cross'): Promise<void> {
    await withVenueError(() => this.requireExchange().cancelOrders({ marketAcc: this.marketAcc(tokenId, mode, marketId), marketId, cancelAll: true, orderIds: [] }))
  }

  async close(): Promise<void> {
    // REST + http transports: nothing persistent to release
  }
}
