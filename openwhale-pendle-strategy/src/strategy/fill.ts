import type { BorosSide } from '@openwhaleorg/pendle'

/**
 * What to do about an accidental fill (design S6, 2026-08-27). Pure — the
 * strategy feeds it live numbers, the tests feed it scenarios.
 *
 * A maker-reward strategy wants no position at all, so a fill is damage, and
 * getting flat is a choice between two costs. Crossing pays the spread plus
 * whatever depth the book lacks, and pays it now. Resting pays nothing but has
 * no deadline, and every second it waits the rate is free to move further
 * against us.
 *
 * So the decision is made on what crossing would ACTUALLY cost — the whole
 * size simulated against the resting book, not the spread, which is only what
 * the first YU pays. Measured against the touch and never against the entry:
 * the entry is sunk and has no bearing on whether crossing now is expensive.
 * Deciding from it produces exactly the wrong reflex — the further underwater,
 * the more reluctant to close.
 *
 * Two overrides sit above the policy, because "wait for a better price" is a
 * plan with no end: a clock, and a move against us.
 */

export type FillPolicy = 'limit' | 'partial' | 'ladder' | 'hold'

export interface FillParams {
  /** Cross straight away when the simulated close lands within this of the touch. 0 = always cross. */
  fillSlippage: number
  fillPolicy: FillPolicy
  /** Cross regardless once the position has been open this long. 0 = never. */
  fillTimeoutMs: number
  /** Cross regardless once mid has moved this far against the position, as a fraction of entry. 0 = off. */
  fillStopDistance: number
  fillSlices: number
  fillSliceIntervalMs: number
}

export interface FillSnapshot {
  /** Deviation from the baseline, absolute, in YU. */
  outstanding: number
  /** The side we must trade to get flat: a long position is closed by a short. */
  closeSide: BorosSide
  midApr: number
  now: number
  /** When the deviation first appeared. */
  since: number
  /** Mid at that moment — the synthetic stop measures from here. */
  entryApr: number
  /** Deviation at detection: a ladder slices THIS, not the shrinking remainder. */
  sizeAtDetect: number
  lastSliceTs?: number
  /**
   * Simulated cost of crossing the whole outstanding size, as a fraction of
   * the touch. Undefined when the venue would not price it — which is not a
   * reason to stop deciding: a book too broken to quote is exactly when a stop
   * matters most, and the overrides need no cost to fire.
   */
  slippage?: number
}

export type FillDecision =
  | { action: 'cross'; reason: string; maxSizeYu?: number; sliced?: boolean }
  | { action: 'rest'; reason: string }
  | { action: 'cancel-only'; reason: string }

/**
 * @param probeAffordable Largest size that still crosses within budget. A
 *   callback rather than a number because finding it costs several venue
 *   round-trips, and only one branch ever needs it.
 */
export async function decideFill(
  s: FillSnapshot,
  p: FillParams,
  probeAffordable: () => Promise<number>,
): Promise<FillDecision> {
  /* Adverse = the direction that makes CLOSING worse. A long is closed by
     selling into the bid, so it worsens as mid falls; a short by lifting the
     ask, so it worsens as mid rises. Put this way the sign needs no view on
     which leg earns what — only on which way we have to trade. */
  const against = s.closeSide === 'short' ? s.entryApr - s.midApr : s.midApr - s.entryApr
  const adverse = s.entryApr > 0 ? against / s.entryApr : 0

  if (p.fillStopDistance > 0 && adverse >= p.fillStopDistance) {
    return { action: 'cross', reason: `mid moved ${(adverse * 100).toFixed(1)}% against the position` }
  }
  if (p.fillTimeoutMs > 0 && s.now - s.since >= p.fillTimeoutMs) {
    return { action: 'cross', reason: `open for ${Math.round((s.now - s.since) / 1000)}s` }
  }
  if (p.fillSlippage === 0) return { action: 'cross', reason: 'slippage budget is off — always cross' }
  // Unpriceable is not free: rest and look again rather than cross blind.
  if (s.slippage === undefined) return { action: 'rest', reason: 'the venue would not price the close' }
  if (s.slippage <= p.fillSlippage) {
    return { action: 'cross', reason: `close costs ${(s.slippage * 100).toFixed(2)}%, within the ${(p.fillSlippage * 100).toFixed(2)}% budget` }
  }

  const tooDear = `close costs ${(s.slippage * 100).toFixed(2)}%, over the ${(p.fillSlippage * 100).toFixed(2)}% budget`
  switch (p.fillPolicy) {
    case 'hold':
      return { action: 'cancel-only', reason: `${tooDear} — holding` }

    case 'partial': {
      const affordable = await probeAffordable()
      // A slice too small to be worth its own relayed transaction is not a
      // partial close, it is a fee. Below a fiftieth, wait instead.
      if (affordable > s.outstanding * 0.02) {
        return { action: 'cross', maxSizeYu: affordable, reason: `${tooDear} — crossing the ${affordable.toFixed(2)} YU the book absorbs within it` }
      }
      return { action: 'rest', reason: `${tooDear}, and no size crosses within it` }
    }

    case 'ladder':
      if ((s.lastSliceTs ?? 0) <= s.now - p.fillSliceIntervalMs) {
        /* Sliced from the size at DETECTION. Slicing the remainder is Zeno's
           ladder — every step smaller than the last, arriving never. */
        return { action: 'cross', maxSizeYu: s.sizeAtDetect / p.fillSlices, sliced: true, reason: `${tooDear} — ladder slice` }
      }
      return { action: 'rest', reason: `${tooDear} — resting between ladder slices` }

    case 'limit':
    default:
      return { action: 'rest', reason: tooDear }
  }
}
