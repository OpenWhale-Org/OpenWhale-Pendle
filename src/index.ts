export { BorosSession } from './session.js'
export type { BorosSessionOptions, BorosMarketSummary, MakerCampaign, MakerCampaignSide } from './session.js'
export { BorosRatesAccount } from './account.js'
export { borosAgentCredentialType } from './credentialType.js'
export { borosPlugin } from './plugin.js'

// Kind contract — merged into core's kind table
import type { BorosSession as BorosSessionClass } from './session.js'
import type { BorosRatesAccount as BorosRatesAccountClass } from './account.js'
declare module '@openwhaleorg/core' {
  interface AdapterKindMap {
    'boros/rates': { session: BorosSessionClass; reader: BorosRatesAccountClass }
  }
}

export { default } from './plugin.js'
