import type { OpenWhalePlugin, PluginFactory } from '@openwhaleorg/core'
import { PACKAGE_VERSION } from './version.js'
import { MarketWatchMonitor, marketWatchParamsSchema } from './monitor/MarketWatchMonitor.js'
import { MakerExecutor } from './executor/MakerExecutor.js'
import { MakerStrategy } from './strategy/MakerStrategy.js'
import { PENDLE_LOGO } from '@openwhaleorg/pendle'

/**
 * pendle-strategy — OpenWhale Pendle Strategy: Pendle / Boros strategies (maker rewards first). Depends on the
 * pendle venue plugin (kind 'pendle/rates', the agent credential, the
 * BorosSession trading surface) and on nothing else venue-wise.
 */
export const pendleMakerPlugin: PluginFactory = (): OpenWhalePlugin => {
  const now = new Date().toISOString()
  return {
    name: 'pendle-strategy',
    version: PACKAGE_VERSION,
    logo: PENDLE_LOGO,
    readme: [
      '# OpenWhale Pendle Strategy',
      '',
      'An open-source collection of Pendle / Boros strategies. Shipping today: **Boros Maker Rewards** (`boros-maker`); more to follow.',
      '',
      '## Boros Maker Rewards',
      '',
      'Farms Boros **maker incentives**: rests post-only orders at the far edge of each side\'s incentive band and follows the band as mid moves. Reward per hour = the side\'s budget × our share of in-band liquidity — the band is not distance-weighted, so the edge earns what the touch earns at a fraction of the fill risk.',
      '',
      '## Run it',
      '- Have a **Boros Account** (see the pendle plugin\'s setup) with collateral deposited into the market you pick and a USD gas balance.',
      '- Run **Scan maker incentives** and pick a market with a live budget and a small pool.',
      '- Create a **market-watch** monitor instance keyed by that market id (or let the strategy subscribe to it).',
      '- Create one strategy instance per market. It starts in **dry run** — it logs every cancel/place it would send. Switch dryRun off to go live.',
      '',
      '## Size',
      'Fixed YU, or a **percentage of what the margin can currently open** — recomputed every tick, so the size follows the balance instead of a number typed once. Capacity is the account\'s equity divided by the margin the venue asks per YU, minus whatever the baseline occupies; the percentage applies to each side rather than being split between them. Equity rather than free margin, because free margin nets out our own resting orders and sizing against it shrinks the target every time it is met.',
      '',
      '## Risk posture',
      '- Both sides rest at `edgeRatio × range` from mid; re-quoted only when out of band or closer than `safeDistanceRatio × range`. The cancels and places of one tick travel in one relayed transaction (~$0.01–0.02 of Arbitrum gas).',
      '- Quoting pauses below the gas floor. Deposits are never automated.',
      '',
      '## After an accidental fill',
      'A fill is damage, and getting flat is a choice between two costs: crossing pays the spread and pays it now, resting pays nothing but has no deadline. An order at the band edge is usually taken *because the market moved to it*, so crossing straight back realises the spread on an adverse move — which is why it is no longer done unconditionally.',
      '',
      'The venue simulates the whole close against the resting book and answers with the average rate it would actually get. Within `fillSlippage` of the touch, cross. Over it, `fillPolicy` decides: **limit** (rest a post-only close at the touch), **partial** (cross what the book absorbs within budget), **ladder** (a slice per interval), **hold** (keep it). Measured against the touch and never the entry — the entry is sunk, and deciding from it makes you least willing to close exactly when you are most underwater.',
      '',
      'Two overrides sit above every policy: `fillTimeoutMs` and `fillStopDistance`. The stop is **synthetic** — Boros has no conditional orders, so the strategy watches and fires the IOC itself. It protects only while the engine runs, and not through a restart.',
      '',
      'No new edge orders go out until the position is flat.',
      '',
      '## Baseline — and why a dedicated sub-account',
      'At every activation the strategy snapshots what the **cross** account already holds on the market (position size + resting order ids) and treats it as untouchable: it only adds orders on top, never cancels baseline orders, and only flattens deviations from the baseline size. Isolated-margin positions and orders are never touched at all.',
      '',
      'This is best effort. The venue does not isolate the account, so a manual trade placed *after* activation is indistinguishable from an accidental fill and would be flattened. **Run the strategy on its own Boros sub-account** (the agent credential\'s `Sub-account Id`, e.g. 1) with its own collateral — then the baseline is trivially empty and nothing you do by hand can collide with it. The snapshot can be switched off (`baselineSnapshot`), which treats everything on the market as the strategy\'s own.',
    ].join('\n'),
    monitorImplementations: [
      {
        id: 'market-watch',
        contract: 'market-watch',
        displayName: 'Boros market watch',
        description: 'One Boros market\'s maker picture every few seconds: mid/mark APR, the incentive band and budget per side, the pool we share it with, and the size already resting in band. Key: market id.',
        params: marketWatchParamsSchema,
        create: (ctx) => new MarketWatchMonitor(ctx),
      },
    ],
    executors: [
      {
        definition: {
          id: 'maker',
          name: 'Boros Maker Executor',
          description: 'Idempotent requote / quote / cancel / flatten over one Boros account. requote cancels and re-rests any number of sides in ONE relayed transaction; flatten IOCs the deviation after an accidental fill. simulate* variants log without sending.',
          source: 'plugin',
          pluginName: 'pendle-strategy',
          supportedActions: ['requote', 'quote', 'cancel', 'flatten', 'simulateRequote', 'simulateQuote', 'simulateCancel', 'simulateFlatten'],
          createdAt: now,
          updatedAt: now,
        },
        instance: new MakerExecutor(),
      },
    ],
    strategies: [
      {
        definition: {
          id: 'boros-maker',
          name: 'Boros Maker Rewards',
          description: 'Rests post-only orders at the far edge of the Boros maker-incentive band on both sides and follows the band as mid moves; an accidental fill is flattened at once; one instance per market; starts in dry run.',
          source: 'plugin',
          pluginName: 'pendle-strategy',
          accountRequirements: [{ label: 'boros', kind: 'pendle/rates' }],
          createdAt: now,
          updatedAt: now,
        },
        factory: () => new MakerStrategy(),
      },
    ],
  }
}

export default pendleMakerPlugin
