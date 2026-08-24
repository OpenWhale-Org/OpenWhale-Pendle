import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'
import { Agent, Exchange, getOpenApiSdk } from '@pendle/boros-sdk-public'

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

  async orderBook(marketId: number, tickSize: 0.0001 | 0.001 | 0.01 | 0.1 = 0.001): Promise<unknown> {
    return (await this.api.markets.marketsControllerGetOrderBook({ marketId, tickSize })).data
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

  async close(): Promise<void> {
    // REST + http transports: nothing persistent to release
  }
}
