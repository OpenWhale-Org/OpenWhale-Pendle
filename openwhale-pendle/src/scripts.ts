import { z } from 'zod'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'
import { Agent, Exchange, getOpenApiSdk } from '@pendle/boros-sdk-public'
import type { CredentialStore, ScriptDefinition } from '@openwhaleorg/core'

const DEFAULT_RPC = 'https://arb1.arbitrum.io/rpc'

function normalizeKey(key: string): `0x${string}` {
  return (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`
}

/**
 * pendle/setup-agent — the one-time onboarding: generate a fresh agent keypair,
 * approve it with the ROOT wallet (read from the chosen web3/evm credential,
 * used for one EIP-712 signature relayed through the Boros API — no on-chain
 * gas from the wallet), then store the agent as a 'boros/agent' credential.
 * The root key is read, signs once, and is dropped.
 */
export function setupAgentScript(credentials: CredentialStore): ScriptDefinition {
  return {
    id: 'setup-agent',
    name: 'Set up Boros agent',
    description: 'Generate + approve a Boros trading agent from a web3/evm root wallet, and store it as a boros/agent credential.',
    paramsSchema: z.object({
      rootCredential: z.string().meta({ displayName: 'Root wallet credential (web3/evm)' }),
      credentialName: z.string().default('Boros Agent').meta({ displayName: 'Name for the new credential' }),
      accountId: z.coerce.number().int().min(0).default(0).meta({ displayName: 'Sub-account id' }),
      expiryDays: z.coerce.number().int().min(1).max(365).default(180).meta({ displayName: 'Agent validity (days)' }),
    }),
    paramOptions: async () => {
      const infos = await credentials.list()
      return {
        rootCredential: infos.filter(i => i.type === 'web3/evm').map(i => ({ value: i.name, label: i.name })),
      }
    },
    run: async ({ params, emit }) => {
      const { type, data } = await credentials.getByName(String(params['rootCredential']))
      if (type !== 'web3/evm') throw new Error(`Credential "${String(params['rootCredential'])}" is "${type}", need web3/evm`)
      const rootAccount = privateKeyToAccount(normalizeKey(String(data['privateKey'])))
      emit?.(`root wallet: ${rootAccount.address}`)

      const walletClient = createWalletClient({ account: rootAccount, chain: arbitrum, transport: http(DEFAULT_RPC) })
      // Official derivation: the agent key comes from the root's signature over
      // Boros's welcome message — losing the stored key is recoverable by
      // re-running this script (same signature → same agent).
      const { agent, privateKey: agentPrivateKey } = await Agent.create(walletClient)
      const agentAddress = await agent.getAddress()
      emit?.(`derived agent: ${agentAddress}`)

      const accountId = Number(params['accountId'])
      const exchange = new Exchange(walletClient, rootAccount.address, accountId, [DEFAULT_RPC], agent)
      const expiry_s = Math.floor(Date.now() / 1000) + Number(params['expiryDays']) * 86400
      emit?.('approving agent (root signs once, relayed via Boros API)…')
      await exchange.approveAgent(agent, undefined, expiry_s)
      const confirmedExpiry = await exchange.getAgentExpiryTime()
      emit?.(`approved — expiry on-record: ${new Date(confirmedExpiry * 1000).toISOString()}`)

      const name = String(params['credentialName'])
      await credentials.set(name, 'pendle/boros-agent', {
        rootAddress: rootAccount.address,
        agentPrivateKey,
        accountId,
      })
      return {
        text: [
          `Boros agent ready.`,
          `  root:     ${rootAccount.address}`,
          `  agent:    ${agentAddress}`,
          `  expiry:   ${new Date(confirmedExpiry * 1000).toISOString()}`,
          `  stored:   credential "${name}" (pendle/boros-agent)`,
          ``,
          `Next: create a Boros Account on the Accounts page binding "${name}".`,
        ].join('\n'),
        json: { root: rootAccount.address, agent: agentAddress, expiry: confirmedExpiry, credential: name },
      }
    },
  }
}

/**
 * pendle/scan-incentives — the live maker-budget scan, sized to a capital
 * figure. For every market with a live campaign it asks the venue how much
 * margin one YU at the band edge needs (anonymous order simulation — linear
 * in size, so one probe per side suffices), turns the capital into a per-side
 * order size, and ranks markets by the reward that size would earn against
 * the pool already resting in band. The pick comes with its reasons and the
 * strategy parameters to type in.
 */
interface SideCampaign { incentiveRange: number; budgetPerHour: number; currentInRangeLiquidity: string }
interface SidePlan {
  side: 'long' | 'short'
  budgetPerHour: number
  poolYu: number
  range: number
  edgeApr: number
  marginPerYu: number
  sizeYu: number
  share: number
  rewardPerHour: number
}
interface MarketPlan {
  marketId: number
  symbol: string
  collateral: string
  collateralUsd: number
  isolatedOnly: boolean
  daysToMaturity: number
  midApr: number
  sides: SidePlan[]
  rewardPerHour: number
  usdPerDay: number
  /** What the market can still pay before it matures (budget stops at expiry). */
  usdToMaturity: number
  aprOnCapital: number
}

/**
 * The scan as a page rather than a column of figures.
 *
 * The ranking is what the text report already gives; what it cannot give is
 * the SHAPE of the field — whether the top market is twice the next or barely
 * ahead, and how much of each one's reward survives its maturity. Both are
 * comparisons across a nominal list, so both are bars, and days-to-maturity
 * rides as a label rather than a second axis: two scales on one frame is the
 * one chart mistake that reliably misleads.
 *
 * Self-contained by necessity — it renders in a sandboxed iframe with no
 * same-origin and no network worth relying on, so no fonts, no CDN, no fetch.
 */
function renderReport(input: {
  plans: MarketPlan[]
  capitalUsd: number
  wantSides: string
  marginUse: number
  edgeRatio: number
  pendleUsd: number
  paramsBlock: string[]
  why: string[]
}): string {
  const { plans, capitalUsd, marginUse, edgeRatio, pendleUsd, paramsBlock, why } = input
  const best = plans[0]!
  const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
  const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`
  const money = (x: number) => `$${x.toFixed(2)}`

  const maxDay = Math.max(...plans.map(p => p.usdPerDay), 1e-9)
  const maxTotal = Math.max(...plans.map(p => p.usdToMaturity), 1e-9)

  /* One hue for magnitude — a single series needs no categorical palette, and
     the title names it, so no legend either. Long and short DO need telling
     apart, and that pair is validated against this surface for colour-vision
     deficiency; they are also directly labelled, so identity never rests on
     colour alone. */
  const bar = (frac: number, label: string, sub: string, hue: string) => `
    <div class="row">
      <div class="rl">${label}</div>
      <div class="rt"><div class="rf" style="width:${(Math.max(0, Math.min(1, frac)) * 100).toFixed(2)}%;background:${hue}"></div></div>
      <div class="rv">${sub}</div>
    </div>`

  const rankRows = plans.map(p => bar(
    p.usdPerDay / maxDay,
    esc(p.symbol.length > 30 ? `${p.symbol.slice(0, 29)}…` : p.symbol),
    `${money(p.usdPerDay)}/d · ${pct(p.aprOnCapital)} · ${p.daysToMaturity.toFixed(0)}d left`,
    'var(--s1)',
  )).join('')

  const totalRows = plans
    .slice()
    .sort((a, b) => b.usdToMaturity - a.usdToMaturity)
    .map(p => bar(
      p.usdToMaturity / maxTotal,
      esc(p.symbol.length > 30 ? `${p.symbol.slice(0, 29)}…` : p.symbol),
      `${money(p.usdToMaturity)} over ${p.daysToMaturity.toFixed(0)}d`,
      'var(--s1)',
    )).join('')

  // Part-to-whole: our size against the pool it dilutes into, per side.
  const shareRows = best.sides.map(s => {
    const hue = s.side === 'long' ? 'var(--long)' : 'var(--short)'
    const ours = s.share
    return `
    <div class="row share-row">
      <div class="rl">${s.side}</div>
      <div class="rt">
        <div class="rf" style="width:${(ours * 100).toFixed(2)}%;background:${hue}"></div>
      </div>
      <div class="rv">${s.sizeYu} of ${(s.poolYu + s.sizeYu).toFixed(0)} YU → ${pct(ours)} of ${s.budgetPerHour.toFixed(2)}/h</div>
    </div>`
  }).join('')

  const tableRows = plans.map((p, i) => `
    <tr>
      <td class="n">${i + 1}</td>
      <td>${esc(p.symbol)}${p.isolatedOnly ? ' <span class="tag">isolated</span>' : ''}</td>
      <td class="n">${(p.rewardPerHour * 24).toFixed(2)}</td>
      <td class="n">${money(p.usdPerDay)}</td>
      <td class="n">${pct(p.aprOnCapital)}</td>
      <td class="n">${money(p.usdToMaturity)}</td>
      <td class="n">${p.daysToMaturity.toFixed(0)}d</td>
      <td class="n">±${pct(p.sides[0]!.range, 2)}</td>
      <td>${p.sides.map(s => `${s.side === 'long' ? 'L' : 'S'} ${s.sizeYu}/${s.poolYu.toFixed(0)} ${pct(s.share, 0)}`).join(' · ')}</td>
    </tr>`).join('')

  return `<!doctype html><html><head><meta charset="utf-8"><title>Maker incentive scan</title>
<style>
  :root {
    --bg:#101012; --panel:#17171a; --line:#26262b;
    --ink:#d4d4d8; --ink2:#8b8b93;
    --s1:#6366f1;            /* magnitude — one hue, one series */
    --long:#6366f1; --short:#d97706;   /* validated pair, dark surface */
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:14px 16px 22px; background:var(--bg); color:var(--ink);
         font:12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-size:13px; margin:0 0 2px; font-weight:600; }
  h2 { font-size:11px; margin:20px 0 8px; font-weight:600; color:var(--ink2);
       text-transform:uppercase; letter-spacing:.08em; }
  .sub { color:var(--ink2); margin:0 0 4px; }
  .hero { display:flex; gap:22px; align-items:baseline; flex-wrap:wrap;
          background:var(--panel); border:1px solid var(--line); border-radius:6px;
          padding:12px 14px; margin-top:12px; }
  .big { font-size:22px; font-weight:600; letter-spacing:-.01em; }
  .unit { color:var(--ink2); font-size:11px; margin-left:4px; }
  .kv { color:var(--ink2); }
  .kv b { color:var(--ink); font-weight:600; }

  .row { display:grid; grid-template-columns:minmax(0,15em) 1fr minmax(0,22em);
         gap:10px; align-items:center; padding:2px 0; }
  .rl { color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .rt { height:12px; background:#1d1d21; border-radius:3px; overflow:hidden; }
  .rf { height:100%; border-radius:0 3px 3px 0; }   /* anchored to the baseline */
  .rv { color:var(--ink2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .share-row { grid-template-columns:minmax(0,6em) 1fr minmax(0,26em); }
  @media (max-width:720px) { .row { grid-template-columns:minmax(0,10em) 1fr; } .rv { grid-column:2; } }

  table { width:100%; border-collapse:collapse; margin-top:4px; }
  th { text-align:left; font-weight:600; color:var(--ink2); font-size:10px;
       text-transform:uppercase; letter-spacing:.06em; padding:4px 8px 4px 0;
       border-bottom:1px solid var(--line); white-space:nowrap; }
  td { padding:3px 8px 3px 0; border-bottom:1px solid #1c1c20; white-space:nowrap; }
  td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; }
  tbody tr:hover { background:#1b1b1f; }
  .tag { color:var(--ink2); font-size:10px; }
  .wrap { overflow-x:auto; }
  ul { margin:6px 0; padding-left:16px; color:var(--ink); }
  li { margin:3px 0; }
  pre { background:var(--panel); border:1px solid var(--line); border-radius:6px;
        padding:10px 12px; overflow-x:auto; margin:6px 0 0; color:var(--ink); }
  .note { color:var(--ink2); margin-top:14px; }
</style></head><body>

<h1>Maker incentive scan</h1>
<p class="sub">$${capitalUsd} capital · ${(marginUse * 100).toFixed(0)}% as margin · edge ${edgeRatio} · PENDLE $${pendleUsd.toFixed(3)} · ${plans.length} markets with a live budget</p>

<div class="hero">
  <div><div class="big">${esc(best.symbol)}</div></div>
  <div><span class="big">${money(best.usdPerDay)}</span><span class="unit">/day</span></div>
  <div><span class="big">${pct(best.aprOnCapital)}</span><span class="unit">APR on capital</span></div>
  <div class="kv">${(best.rewardPerHour * 24).toFixed(2)} PENDLE/day · <b>${best.daysToMaturity.toFixed(0)}d</b> to maturity · ${money(best.usdToMaturity)} total</div>
</div>

<h2>Per day, at today's pool</h2>
${rankRows}

<h2>Total before maturity</h2>
<p class="sub">The budget stops at expiry, so a higher daily rate does not always win.</p>
${totalRows}

<h2>${esc(best.symbol)} — your share of each side</h2>
<p class="sub">Reward share is size ÷ (pool + size); the band is not distance-weighted.</p>
${shareRows}

<h2>Why</h2>
<ul>${why.map(w => `<li>${esc(w.replace(/^•\s*/, ''))}</li>`).join('')}</ul>

<h2>Strategy parameters</h2>
<pre>${esc(paramsBlock.join('\n'))}</pre>

<h2>All markets</h2>
<div class="wrap"><table>
  <thead><tr><th class="n">#</th><th>Market</th><th class="n">PENDLE/d</th><th class="n">$/d</th><th class="n">APR</th><th class="n">$ to expiry</th><th class="n">Left</th><th class="n">Band</th><th>Sides (size/pool share)</th></tr></thead>
  <tbody>${tableRows}</tbody>
</table></div>

<p class="note">The pool is what rests in band right now — others can join and dilute you. Budgets are per epoch and can change. Margin per YU came from the venue's own simulation at the band edge.</p>
</body></html>`
}

export const scanIncentivesScript: ScriptDefinition = {
  id: 'scan-incentives',
  name: 'Scan maker incentives',
  description: 'Rank Boros markets with a live maker-incentive budget by what a given capital would earn resting at the band edge, and spell out the best pick with its strategy parameters.',
  paramsSchema: z.object({
    capitalUsd: z.coerce.number().positive().default(1000).meta({ displayName: 'Capital (USD)', description: 'Collateral you would deposit into the chosen market. Sized into orders through the venue\'s own margin requirement.' }),
    sides: z.enum(['both', 'long', 'short']).default('both').meta({ displayName: 'Sides', description: 'both splits the capital across the two sides (each needs its own margin); a single side puts it all on one.' }),
    marginUse: z.coerce.number().min(0.1).max(1).default(0.8).meta({ displayName: 'Margin use', description: 'Fraction of the capital committed as order margin; the rest stays as buffer against a fill and rate moves.' }),
    edgeRatio: z.coerce.number().min(0.5).max(1).default(0.95).meta({ displayName: 'Edge ratio', description: 'Where the order rests as a fraction of the band half-width — mirror the strategy\'s value.' }),
  }),
  run: async ({ params, emit, signal }) => {
    const capitalUsd = Number(params['capitalUsd'] ?? 1000)
    const wantSides = String(params['sides'] ?? 'both') as 'both' | 'long' | 'short'
    const marginUse = Number(params['marginUse'] ?? 0.8)
    const edgeRatio = Number(params['edgeRatio'] ?? 0.95)
    const api = getOpenApiSdk()

    const assets = ((await api.assets.assetsControllerListAssets({})).data as { results?: Array<{ tokenId: number; symbol: string; usdPrice: string }> }).results ?? []
    const priceOf = (tokenId: number) => assets.find(a => a.tokenId === tokenId)
    const pendleUsd = Number(assets.find(a => a.symbol.toUpperCase() === 'PENDLE')?.usdPrice ?? 0)

    const markets = ((await api.markets.marketsControllerListMarkets({ isMatured: false, isUiWhitelisted: true, limit: 100 })).data as {
      results?: Array<{ marketId: number; tokenId: number; imData: { symbol: string; maturity: number; isIsolatedOnly?: boolean } }>
    }).results ?? []
    const now = Date.now() / 1000
    emit?.(`${markets.length} live markets · PENDLE $${pendleUsd.toFixed(3)} · capital $${capitalUsd} (${(marginUse * 100).toFixed(0)}% as margin, sides: ${wantSides})`)

    const plans: MarketPlan[] = []
    for (const m of markets) {
      if (signal?.aborted) { emit?.('stopped — ranking what was scanned so far'); break }
      let campaign: { addLiquidityIncentive?: Record<'long' | 'short', SideCampaign | undefined> }
      try { campaign = (await api.miscellaneous.incentivesControllerGetMakerIncentiveCampaign(m.marketId)).data as typeof campaign } catch { continue }
      const live = (['long', 'short'] as const).filter(sd => (campaign.addLiquidityIncentive?.[sd]?.budgetPerHour ?? 0) > 0 && (wantSides === 'both' || wantSides === sd))
      if (live.length === 0) continue
      const price = priceOf(m.tokenId)
      const collateralUsd = Number(price?.usdPrice ?? 0)
      if (!(collateralUsd > 0)) continue
      const detail = ((await api.markets.marketsControllerGetMarketsByIds({ marketIds: String(m.marketId) })).data as { results?: Array<{ data?: { midApr?: number } }> })
      const midApr = (detail.results ?? (detail as unknown as Array<{ data?: { midApr?: number } }>))[0]?.data?.midApr
      if (typeof midApr !== 'number') continue

      const perSideCapital = (capitalUsd * marginUse) / live.length / collateralUsd   // in collateral units
      const sides: SidePlan[] = []
      for (const sd of live) {
        const c = campaign.addLiquidityIncentive![sd]!
        const edgeApr = sd === 'long' ? midApr - c.incentiveRange * edgeRatio : midApr + c.incentiveRange * edgeRatio
        const probeYu = 100
        let marginPerYu: number
        try {
          const sim = (await api.simulations.simulationsControllerSimulatePlaceOrderAnonymous({
            marketId: m.marketId, side: sd === 'long' ? 0 : 1, size: (BigInt(probeYu) * 10n ** 18n).toString(), rate: edgeApr, tif: 3,
          })).data as { marginRequired: string }
          marginPerYu = Number(sim.marginRequired) / 1e18 / probeYu
        } catch { continue }
        if (!(marginPerYu > 0)) continue
        // Whole YU on stable collateral; two decimals where one YU is a whole BTC/ETH
        const raw = perSideCapital / marginPerYu
        const sizeYu = raw >= 100 ? Math.floor(raw) : Math.floor(raw * 100) / 100
        if (sizeYu <= 0) continue
        const poolYu = Number(c.currentInRangeLiquidity) / 1e18
        const share = sizeYu / (poolYu + sizeYu)
        sides.push({ side: sd, budgetPerHour: c.budgetPerHour, poolYu, range: c.incentiveRange, edgeApr, marginPerYu, sizeYu, share, rewardPerHour: c.budgetPerHour * share })
      }
      if (sides.length === 0) continue
      const rewardPerHour = sides.reduce((a, s) => a + s.rewardPerHour, 0)
      const usdPerDay = rewardPerHour * 24 * pendleUsd
      plans.push({
        marketId: m.marketId, symbol: m.imData.symbol, collateral: price?.symbol ?? String(m.tokenId), collateralUsd,
        isolatedOnly: m.imData.isIsolatedOnly === true, daysToMaturity: (m.imData.maturity - now) / 86400, midApr, sides,
        rewardPerHour, usdPerDay, usdToMaturity: usdPerDay * Math.max(0, (m.imData.maturity - now) / 86400), aprOnCapital: capitalUsd > 0 ? (usdPerDay * 365) / capitalUsd : 0,
      })
      emit?.(`${m.imData.symbol}: ${rewardPerHour.toFixed(4)} PENDLE/h = ${(rewardPerHour * 24).toFixed(2)} PENDLE/day (≈ $${usdPerDay.toFixed(2)} at $${pendleUsd.toFixed(3)})`)
    }
    plans.sort((a, b) => b.usdPerDay - a.usdPerDay)
    if (plans.length === 0) return { text: 'No live maker-incentive budgets right now.', json: [] }

    const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`
    const sideCell = (s: SidePlan) => `${s.side === 'long' ? 'L' : 'S'} ${s.sizeYu}YU/${s.poolYu.toFixed(0)} ${pct(s.share, 0)} of ${s.budgetPerHour.toFixed(2)}/h`
    const rows = plans.map((p, i) =>
      `${String(i + 1).padStart(2)}. ${p.symbol.padEnd(34)} ${(p.rewardPerHour * 24).toFixed(2).padStart(7)} PENDLE/d (≈$${p.usdPerDay.toFixed(2).padStart(6)}) ${pct(p.aprOnCapital).padStart(7)} APR  ${(p.rewardPerHour * 24 * p.daysToMaturity).toFixed(0).padStart(5)} PENDLE to expiry  ±${pct(p.sides[0]!.range, 2)}  ${p.daysToMaturity.toFixed(0).padStart(3)}d  ${p.sides.map(sideCell).join('  ')}`)

    const best = plans[0]!
    const second = plans[1]
    const why: string[] = []
    for (const s of best.sides) {
      why.push(`• ${s.side}: $${(capitalUsd * marginUse / best.sides.length).toFixed(0)} of margin buys ${s.sizeYu} YU (the venue asks ${pct(s.marginPerYu, 2)} of notional per YU at ${pct(s.edgeApr, 2)} APR). Against the ${s.poolYu.toFixed(1)} YU already in band that is a ${pct(s.share)} share of the ${s.budgetPerHour.toFixed(3)} PENDLE/h budget → ${s.rewardPerHour.toFixed(4)} PENDLE/h.`)
    }
    why.push(`• Band ±${pct(best.sides[0]!.range, 2)} around a mid of ${pct(best.midApr, 2)}: resting at ${pct(edgeRatio, 0)} of the half-width keeps the order ${pct(best.sides[0]!.range * edgeRatio, 2)} from mid.`)
    why.push(`• ${best.daysToMaturity.toFixed(0)} days to maturity${best.daysToMaturity < 7 ? ` — the budget stops at expiry, so this is ≈ ${(best.rewardPerHour * 24 * best.daysToMaturity).toFixed(1)} PENDLE (≈ $${best.usdToMaturity.toFixed(0)}) in total; re-run the scan afterwards` : ''}${best.isolatedOnly ? ' · isolated-only market (marginMode auto → isolated)' : ''} · collateral ${best.collateral} ($${best.collateralUsd.toFixed(2)}).`)
    const longest = plans.filter(p => p.daysToMaturity >= 14).sort((a, b) => b.usdPerDay - a.usdPerDay)[0]
    if (longest && longest !== best) why.push(`• Best with ≥14 days left: ${longest.symbol} at ${(longest.rewardPerHour * 24).toFixed(2)} PENDLE/day (≈ $${longest.usdPerDay.toFixed(2)}, ${pct(longest.aprOnCapital)} APR) — pick this if you would rather not redeploy in ${best.daysToMaturity.toFixed(0)} days.`)
    if (second) why.push(`• Runner-up ${second.symbol} would earn ${(second.rewardPerHour * 24).toFixed(2)} PENDLE/day (≈ $${second.usdPerDay.toFixed(2)}, ${pct(second.aprOnCapital)} APR) — ${second.usdPerDay < best.usdPerDay * 0.5 ? 'less than half' : 'close; consider splitting the capital'}.`)

    const paramsBlock = [
      `market:            ${best.symbol}  (id ${best.marketId})`,
      `sides:             ${best.sides.length === 2 ? 'both' : best.sides[0]!.side}`,
      `sizeYu:            ${Math.min(...best.sides.map(s => s.sizeYu))}   (per side; the smaller of the two so both fit)`,
      `marginMode:        auto`,
      `edgeRatio:         ${edgeRatio}`,
      `deposit:           $${capitalUsd} of ${best.collateral} into this market's ${best.isolatedOnly ? 'isolated' : 'cross'} account, plus a few USD of gas balance`,
      `expected:          ${best.rewardPerHour.toFixed(4)} PENDLE/h = ${(best.rewardPerHour * 24).toFixed(2)} PENDLE/day (≈ $${best.usdPerDay.toFixed(2)} at PENDLE $${pendleUsd.toFixed(3)} → ${pct(best.aprOnCapital)} APR on the capital; pool and budget as of now)`,
    ]
    const text = [
      `Ranked by PENDLE/day for $${capitalUsd} (${(marginUse * 100).toFixed(0)}% as margin, sides: ${wantSides}); $ figures are estimates at PENDLE $${pendleUsd.toFixed(3)}. Cells: side sizeYU/pool share-of-budget. 1 YU = 1 unit of the collateral token (a whole BTC on BTC-margined markets).`,
      ...rows,
      '',
      `── Best: ${best.symbol} ──────────────────────────────────────────`,
      ...why,
      '',
      '── Strategy parameters ──────────────────────────────────────────',
      ...paramsBlock,
      '',
      'Caveats: the pool is what rests in band RIGHT NOW — others can join and dilute you; the budget is per epoch and can change; reward share is not distance-weighted, so the edge is as good as the touch. Margin per YU was read from the venue\'s own simulation at the band edge.',
    ].join('\n')
    const html = renderReport({ plans, capitalUsd, wantSides, marginUse, edgeRatio, pendleUsd, paramsBlock, why })
    return {
      text,
      json: { capitalUsd, sides: wantSides, marginUse, edgeRatio, pendleUsd, best: best.symbol, plans },
      files: [{ name: `boros-scan-${best.symbol.replace(/[^\w.-]/g, '-')}.html`, mime: 'text/html', content: html }],
    }
  },
}
