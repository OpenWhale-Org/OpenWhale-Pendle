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

/** pendle/scan-incentives — the live maker-budget scan, as a dashboard script. */
export const scanIncentivesScript: ScriptDefinition = {
  id: 'scan-incentives',
  name: 'Scan maker incentives',
  description: 'List unexpired Boros markets with a live maker-incentive budget: band width, per-side budget, pool size.',
  run: async () => {
    const api = getOpenApiSdk()
    const res = (await api.markets.marketsControllerListMarkets({ isMatured: false, isUiWhitelisted: true, limit: 100 })).data as {
      results?: Array<{ marketId: number; imData: { symbol: string; maturity: number } }>
    }
    const now = Date.now() / 1000
    const rows: string[] = []
    const jsonRows: unknown[] = []
    for (const m of res.results ?? []) {
      try {
        const c = (await api.miscellaneous.incentivesControllerGetMakerIncentiveCampaign(m.marketId)).data as {
          addLiquidityIncentive?: Record<'long' | 'short', { incentiveRange: number; budgetPerHour: number; currentInRangeLiquidity: string } | undefined>
        }
        const long = c.addLiquidityIncentive?.long
        const short = c.addLiquidityIncentive?.short
        if ((long?.budgetPerHour ?? 0) <= 0 && (short?.budgetPerHour ?? 0) <= 0) continue
        const days = ((m.imData.maturity - now) / 86400).toFixed(0)
        const fmt = (side?: { budgetPerHour: number; currentInRangeLiquidity: string }) =>
          side ? `${side.budgetPerHour.toFixed(3)}/h pool ${(Number(side.currentInRangeLiquidity) / 1e18).toFixed(1)}` : '—'
        rows.push(`${String(m.marketId).padEnd(5)}${m.imData.symbol.padEnd(34)}${`${days}d`.padEnd(6)}±${((long?.incentiveRange ?? short?.incentiveRange ?? 0) * 100).toFixed(3)}%  L ${fmt(long)}  S ${fmt(short)}`)
        jsonRows.push({ marketId: m.marketId, symbol: m.imData.symbol, daysToMaturity: Number(days), long, short })
      } catch { /* markets without campaigns are simply not listed */ }
    }
    return {
      text: rows.length ? `market  symbol / days-to-maturity / band / per-side budget+pool (YU)\n${rows.join('\n')}` : 'No live maker-incentive budgets right now.',
      json: jsonRows,
    }
  },
}
