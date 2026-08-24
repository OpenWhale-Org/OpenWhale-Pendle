import type { PluginFactory } from '@openwhaleorg/core'
import { borosAgentCredentialType } from './credentialType.js'
import { BorosSession } from './session.js'
import { BorosRatesAccount } from './account.js'
import { setupAgentScript, scanIncentivesScript } from './scripts.js'

/**
 * The Boros venue plugin — a venue-OWNED kind: 'boros/rates' belongs to this
 * package (single-implementation kinds are normal kinds; promote to a shared
 * contract only when a second IRS venue exists).
 *
 * Keyless cell = public market data. Credentialed cell binds 'boros/agent'
 * (the delegated trading key) — the root wallet key ('web3/evm') is only ever
 * touched by the setup-agent script and manual deposits.
 */
export const borosPlugin: PluginFactory = (ctx) => ({
  name: 'boros',
  version: '0.1.0',
  readme: [
    '# boros',
    '',
    'Venue plugin for [Pendle Boros](https://boros.pendle.finance) — interest-rate derivatives on Arbitrum. Owns the `boros/rates` kind.',
    '',
    '## Setup',
    '- Create an **EVM Wallet** credential (`web3/evm`) holding your root wallet key.',
    '- Run the **Set up Boros agent** script: it derives the delegated agent key from one root signature, approves it via the Boros API relay, and stores it as a **Boros Agent** credential. The root key signs once and stays cold.',
    '- Create a **Boros Account** binding the agent credential.',
    '',
    '## What trading looks like',
    'Orders are signed by the agent key and relayed by the official Send Txs Bot; gas is debited from the account\'s on-chain USD gas balance. Deposits/withdrawals are a manual, root-signed concern — this plugin never touches them.',
    '',
    '## Scripts',
    '- **Scan maker incentives** — every unexpired market with a live maker budget: band width, per-side budget, pool size.',
    '- **Set up Boros agent** — the onboarding above; re-running it re-derives the same agent (recoverable).',
  ].join('\n'),
  monitors: [],
  executors: [],
  strategies: [],
  credentialTypes: [borosAgentCredentialType],
  adapters: [
    {
      kind: 'boros/rates',
      venue: 'boros',
      credentialTypes: ['boros/agent'],
      create: (data) => new BorosSession(data ? {
        agentPrivateKey: String(data['agentPrivateKey'] ?? ''),
        rootAddress: String(data['rootAddress'] ?? '') as `0x${string}`,
        accountId: Number(data['accountId'] ?? 0),
      } : {}),
    },
  ],
  accounts: [BorosRatesAccount],
  scripts: [setupAgentScript(ctx.credentials), scanIncentivesScript],
})

export default borosPlugin
