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
