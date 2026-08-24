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
}

export type BorosSide = 'long' | 'short'

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
  side: BorosSide
  /** Implied APR the order rests at (decimal). */
  apr: number
  sizeYu: number
  unfilledYu: number
}

export interface BorosPosition {
  marketId: number
  /** Long positive, short negative — YU. */
  signedSizeYu: number
  positionValue: number
}

const YU = 1e18
const toYu = (raw: bigint | string): number => Number(BigInt(raw)) / YU
const fromYu = (yu: number): bigint => BigInt(Math.round(yu * YU))

function normalizeKey(key: string): `0x${string}` {
  return (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`
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
      imData: { symbol: string; maturity: number }
      metadata?: { fundingRateSymbol?: string }
      platform?: unknown
    }>
    return rows.map(m => ({
      marketId: m.marketId,
      symbol: m.imData.symbol,
      tokenId: m.tokenId,
      maturity: m.imData.maturity,
      platform: m.imData.symbol.split('-')[0] ?? String(m.platform ?? ''),
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

  // ── Account reads (credentialed) ───────────────────────────────────────────

  async gasBalance(): Promise<number> {
    return this.requireExchange().getGasBalance()
  }

  async positions(marketId: number, tokenId: number): Promise<unknown> {
    return this.requireExchange().getUserPositions({ marketId, tokenId })
  }

  async enteredMarkets(): Promise<readonly number[]> {
    return this.requireExchange().getEnteredMarkets(this.rootAddress!)
  }

  async agentExpiry(): Promise<number> {
    return this.requireExchange().getAgentExpiryTime()
  }

  private marketAcc(tokenId: number): `0x${string}` {
    this.requireExchange()
    return MarketAccLib.pack(this.rootAddress!, this.accountId, tokenId, CROSS_MARKET_ID) as `0x${string}`
  }

  /** Cross-margin entry into a market is a one-time on-chain step; idempotent here. */
  async ensureEntered(marketId: number): Promise<void> {
    const entered = await this.enteredMarkets()
    if (entered.includes(marketId)) return
    await this.requireExchange().enterMarkets(true, [marketId])
  }

  async openOrders(marketId: number, tokenId: number): Promise<BorosOpenOrder[]> {
    const { results } = await this.requireExchange().getActiveOrdersFromContract({ marketId, tokenId })
    return results.map(o => ({
      orderId: o.orderId.toString(),
      side: o.side === Side.LONG ? 'long' : 'short',
      apr: o.impliedApr,
      sizeYu: toYu(o.size),
      unfilledYu: toYu(o.unfilledSize),
    }))
  }

  async position(marketId: number, tokenId: number): Promise<BorosPosition | undefined> {
    const positions = await this.requireExchange().getUserPositions({ marketId, tokenId })
    const p = positions.find(x => x.marketId === marketId)
    if (!p) return undefined
    return { marketId, signedSizeYu: toYu(p.signedSize), positionValue: toYu(p.positionValue) }
  }

  // ── Writes (agent-signed, relayed) ─────────────────────────────────────────

  /**
   * Post-only resting order at an APR: ADD_LIQUIDITY_ONLY is rejected rather
   * than crossed, so a maker-reward order can never accidentally take.
   */
  async placeMakerOrder(args: { marketId: number; tokenId: number; side: BorosSide; sizeYu: number; apr: number }): Promise<Record<string, unknown>> {
    const result = await this.requireExchange().placeOrder({
      marketAcc: this.marketAcc(args.tokenId),
      marketId: args.marketId,
      side: args.side === 'long' ? Side.LONG : Side.SHORT,
      size: fromYu(args.sizeYu),
      rate: args.apr,
      tif: TimeInForce.ADD_LIQUIDITY_ONLY,
    })
    return result as unknown as Record<string, unknown>
  }

  /** Immediate-or-cancel order at an aggressive APR — the flatten path after an accidental fill. */
  async takerOrder(args: { marketId: number; tokenId: number; side: BorosSide; sizeYu: number; apr: number }): Promise<Record<string, unknown>> {
    const result = await this.requireExchange().placeOrder({
      marketAcc: this.marketAcc(args.tokenId),
      marketId: args.marketId,
      side: args.side === 'long' ? Side.LONG : Side.SHORT,
      size: fromYu(args.sizeYu),
      rate: args.apr,
      tif: TimeInForce.IMMEDIATE_OR_CANCEL,
    })
    return result as unknown as Record<string, unknown>
  }

  async cancelOrders(marketId: number, tokenId: number, orderIds: string[]): Promise<void> {
    if (orderIds.length === 0) return
    await this.requireExchange().cancelOrders({ marketAcc: this.marketAcc(tokenId), marketId, cancelAll: false, orderIds })
  }

  async cancelAll(marketId: number, tokenId: number): Promise<void> {
    await this.requireExchange().cancelOrders({ marketAcc: this.marketAcc(tokenId), marketId, cancelAll: true, orderIds: [] })
  }

  async close(): Promise<void> {
    // REST + http transports: nothing persistent to release
  }
}
