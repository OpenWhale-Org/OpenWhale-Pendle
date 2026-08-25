export { BorosSession } from './session.js'
export type { BorosSessionOptions, BorosMarketSummary, MakerCampaign, MakerCampaignSide, BorosSide, BorosMarketQuote, BorosBook, BorosBookLevel, BorosOpenOrder, BorosPosition, BorosAccountInfo } from './session.js'
export { BorosRatesAccount } from './account.js'
export { PendleMarketSession, PendleMarketAccount } from './market.js'
export type { PendleValuation } from './market.js'
export { borosAgentCredentialType } from './credentialType.js'
export { pendlePlugin } from './plugin.js'

// Kind contracts — merged into core's kind table
import type { BorosSession as BorosSessionClass } from './session.js'
import type { BorosRatesAccount as BorosRatesAccountClass } from './account.js'
import type { PendleMarketSession as PendleMarketSessionClass } from './market.js'
import type { PendleMarketAccount as PendleMarketAccountClass } from './market.js'
declare module '@openwhaleorg/core' {
  interface AdapterKindMap {
    'pendle/rates': { session: BorosSessionClass; reader: BorosRatesAccountClass }
    'pendle/market': { session: PendleMarketSessionClass; reader: PendleMarketAccountClass }
  }
}

// Plugin-package convention: the entry default-exports the plugin factory
// so runtime.loadPluginFromPath (dashboard install) can load it.
export { default } from './plugin.js'
