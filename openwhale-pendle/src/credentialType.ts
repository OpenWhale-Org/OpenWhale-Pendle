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
  displayName: { en: 'Boros Agent', 'zh-CN': 'Boros 代理' },
  logo: PENDLE_LOGO,
  icon: '🤖',
  description: { en: 'Delegated trading key for Boros — orders only, no withdrawals. Root wallet stays cold.', 'zh-CN': 'Boros 的委托交易密钥——只能下单，不能提现。根钱包保持离线。' },
  schema: z.object({
    rootAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).meta({ displayName: 'Root Wallet Address', i18n: { 'zh-CN': { displayName: '根钱包地址' } } }),
    agentPrivateKey: z.string().min(64).meta({ displayName: 'Agent Private Key', password: true, i18n: { 'zh-CN': { displayName: '代理私钥' } } }),
    accountId: z.coerce.number().int().min(0).default(0).meta({ displayName: 'Sub-account Id', i18n: { 'zh-CN': { displayName: '子账户 Id' } } }),
  }),
  raw: true,
  managed: true,
  test: async (data: RawCredentialData) => {
    const key = String(data['agentPrivateKey'] ?? '')
    privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`)
  },
}
