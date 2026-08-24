import { z } from 'zod'
import { privateKeyToAccount } from 'viem/accounts'
import type { CredentialTypeDefinition, RawCredentialData } from '@openwhaleorg/core'
import { PENDLE_LOGO } from './brand.js'

/**
 * The Boros AGENT credential — the hot key. Signs order placement/cancel only;
 * it cannot withdraw and holds no funds, so losing it costs one re-approval
 * from the root wallet (which lives separately, as 'web3/evm').
 * Created by the pendle/setup-agent script, not by hand.
 */
export const borosAgentCredentialType: CredentialTypeDefinition = {
  type: 'pendle/boros-agent',
  displayName: 'Boros Agent',
  logo: PENDLE_LOGO,
  icon: '🤖',
  description: 'Delegated trading key for Boros — orders only, no withdrawals. Root wallet stays cold.',
  schema: z.object({
    rootAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).meta({ displayName: 'Root Wallet Address' }),
    agentPrivateKey: z.string().min(64).meta({ displayName: 'Agent Private Key', password: true }),
    accountId: z.coerce.number().int().min(0).default(0).meta({ displayName: 'Sub-account Id' }),
  }),
  raw: true,
  managed: true,
  test: async (data: RawCredentialData) => {
    const key = String(data['agentPrivateKey'] ?? '')
    privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`)
  },
}
