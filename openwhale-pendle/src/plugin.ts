import type { PluginFactory } from '@openwhaleorg/core'
import { PACKAGE_VERSION } from './version.js'
import { borosAgentCredentialType } from './credentialType.js'
import { PendleMarketSession, PendleMarketAccount } from './market.js'
import { PENDLE_LOGO } from './brand.js'
import { BorosSession } from './session.js'
import { BorosRatesAccount } from './account.js'
import { setupAgentScript, scanIncentivesScript } from './scripts.js'

/**
 * The Pendle venue plugin — one protocol, two products, two venue-owned
 * kinds: 'pendle/rates' (Boros, the IRS order book) and 'pendle/market'
 * (Pendle V2 PT/YT, read-only v0). Both hang off the shared 'web3/evm'
 * wallet family; Boros trading additionally delegates to a
 * 'pendle/boros-agent' key so the root wallet stays cold.
 */
export const pendlePlugin: PluginFactory = (ctx) => ({
  name: 'pendle',
  version: PACKAGE_VERSION,
  logo: PENDLE_LOGO,
  readme: [
    '# pendle',
    '',
    'Venue plugin for [Pendle](https://www.pendle.finance) — two products under one roof, both opened by the shared `web3/evm` wallet family:',
    '',
    '- **Boros** (`pendle/rates`) — interest-rate derivatives on Arbitrum: an on-chain order book over funding rates.',
    '- **Pendle V2** (`pendle/market`) — PT/YT/LP yield tokenization. v0 is a read-only portfolio view (the hosted API values every position in USD).',
    '',
    '## Boros setup',
    '- Create an **EVM Wallet** credential (`web3/evm`) holding your root wallet key.',
    '- Run the **Set up Boros agent** script: it derives the delegated agent key from one root signature, approves it via the Boros API relay, and stores it as a **Boros Agent** credential. The root key signs once and stays cold.',
    '- Create a **Boros Account** binding the agent credential.',
    '',
    'Orders are signed by the agent key and relayed by the official Send Txs Bot; gas is debited from the account\'s on-chain USD gas balance. Deposits/withdrawals stay manual and root-signed.',
    '',
    '## Pendle V2 setup',
    'Create a **Pendle Account** binding your **EVM Wallet** credential directly — the key only derives the address; positions come from the hosted API.',
    '',
    '## Scripts',
    '- **Scan maker incentives** — every unexpired Boros market with a live maker budget: band width, per-side budget, pool size.',
    '- **Set up Boros agent** — the onboarding above; re-running it re-derives the same agent (recoverable).',
  ].join('\n'),
  monitors: [],
  executors: [],
  strategies: [],
  credentialTypes: [borosAgentCredentialType],
  adapters: [
    {
      kind: 'pendle/rates',
      venue: 'boros',
      credentialTypes: ['pendle/boros-agent'],
      create: (data) => new BorosSession(data ? {
        agentPrivateKey: String(data['agentPrivateKey'] ?? ''),
        rootAddress: String(data['rootAddress'] ?? '') as `0x${string}`,
        accountId: Number(data['accountId'] ?? 0),
      } : {}),
    },
    {
      kind: 'pendle/market',
      venue: 'pendle',
      credentialTypes: ['web3/evm'],
      create: (data) => new PendleMarketSession(
        typeof data?.['privateKey'] === 'string' ? { privateKey: data['privateKey'] } : {},
      ),
    },
  ],
  accounts: [BorosRatesAccount, PendleMarketAccount],
  scripts: [setupAgentScript(ctx.credentials), scanIncentivesScript],
})

export default pendlePlugin
