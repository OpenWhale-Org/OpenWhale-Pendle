/**
 * Probe 2 — which markets have a LIVE maker-incentive budget right now, and
 * how wide their in-range band is. This is the strategy's market-selection
 * ground truth.
 */
import { getOpenApiSdk } from '@pendle/boros-sdk-public'

const api = getOpenApiSdk()
const res = (await api.markets.marketsControllerListMarkets({ isUiWhitelisted: true, isMatured: false, limit: 100 })).data as {
  results?: Record<string, unknown>[]
}
const markets = (res.results ?? (res as unknown as Record<string, unknown>[])) as {
  marketId: number
  imData: { symbol: string; maturity: number }
  data?: Record<string, unknown>
}[]

const now = Date.now() / 1000
const live = markets.filter(m => m.imData.maturity > now)
console.log(`whitelisted, unexpired: ${live.length}`)

const rows: string[] = []
for (const m of live) {
  try {
    const c = (await api.miscellaneous.incentivesControllerGetMakerIncentiveCampaign(m.marketId)).data as {
      addLiquidityIncentive?: {
        long?: { incentiveRange: number; budgetPerHour: number; currentInRangeLiquidity: string }
        short?: { incentiveRange: number; budgetPerHour: number; currentInRangeLiquidity: string }
      }
      filledVolumeIncentive?: { totalEpochReward: number; totalMakerVolume: number; avgRewardPerYu: number }
    }
    const long = c.addLiquidityIncentive?.long
    const short = c.addLiquidityIncentive?.short
    const filled = c.filledVolumeIncentive
    const hasBudget = (long?.budgetPerHour ?? 0) > 0 || (short?.budgetPerHour ?? 0) > 0 || (filled?.totalEpochReward ?? 0) > 0
    if (!hasBudget) continue
    const days = ((m.imData.maturity - now) / 86400).toFixed(0)
    rows.push([
      String(m.marketId).padEnd(4),
      m.imData.symbol.padEnd(32),
      `${days}d`.padEnd(5),
      `range±${((long?.incentiveRange ?? 0) * 100).toFixed(3)}%`,
      `L ${long?.budgetPerHour ?? 0}/h (pool ${Number(long?.currentInRangeLiquidity ?? 0) / 1e18})`,
      `S ${short?.budgetPerHour ?? 0}/h (pool ${Number(short?.currentInRangeLiquidity ?? 0) / 1e18})`,
      `filled: ${filled?.totalEpochReward ?? 0}/epoch avg ${filled?.avgRewardPerYu ?? 0}/YU`,
    ].join('  '))
  } catch { /* market without campaign endpoint */ }
}
console.log(rows.length ? rows.join('\n') : 'NO market currently has a live maker-incentive budget')
