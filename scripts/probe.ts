/**
 * Probe 1 — public surface: markets, one orderbook, maker-incentive campaigns.
 * No credentials, no writes. Answers the three facts the design left open:
 *   ① the exact maker-incentive formula/params (band width, weighting)
 *   ② whether both-side resting orders are allowed (orderbook shape hints)
 *   ③ bulk cancel+place existence (SDK surface — already confirmed: bulkSignAndExecute)
 */
import { getOpenApiSdk } from '@pendle/boros-sdk-public'

const api = getOpenApiSdk()

const markets = (await api.markets.marketsControllerListMarkets({ isUiWhitelisted: true })).data
const list = (markets as { results?: unknown[] }).results ?? markets
console.log(`── markets (${(list as unknown[]).length}) ──`)
for (const m of (list as Record<string, unknown>[]).slice(0, 30)) {
  console.log([
    m['marketId'], m['symbol'] ?? m['name'], 'venue=' + String(m['platform'] ?? m['venue'] ?? '?'),
    'maturity=' + String(m['maturity'] ?? '?'),
  ].join('  '))
}

const first = (list as Record<string, unknown>[])[0]!
const marketId = Number(first['marketId'])

console.log(`\n── maker incentive campaign for market ${marketId} (${String(first['symbol'] ?? first['name'])}) ──`)
try {
  const campaign = (await api.miscellaneous.incentivesControllerGetMakerIncentiveCampaign(marketId)).data
  console.log(JSON.stringify(campaign, null, 2))
} catch (err) {
  console.log('campaign fetch failed:', (err as { error?: unknown; message?: string }).message ?? JSON.stringify((err as { error?: unknown }).error))
}

console.log(`\n── orderbook for market ${marketId} ──`)
const book = (await api.markets.marketsControllerGetOrderBook({ marketId })).data
const bookObj = book as Record<string, unknown>
console.log(JSON.stringify(bookObj, null, 2).slice(0, 1500))
