import type { BorosSide } from '@openwhaleorg/pendle'

/**
 * The corridor rule (design S1–S3, 2026-08-24): a maker-reward order rests at
 * the FAR EDGE of the incentive band and is left alone while its distance to
 * mid stays inside [safe, edge]. It is re-quoted only when it drifts out of
 * the band (no longer earning) or mid creeps too close (fill risk). Pure —
 * the strategy feeds it live numbers, the tests feed it scenarios.
 *
 * APRs are decimals. `range` is the band half-width for the side (the
 * campaign's incentiveRange), so the earning region is [mid − range, mid + range].
 */

export interface CorridorParams {
  /** Where to rest, as a fraction of the band half-width (0.95 = just inside the edge). */
  edgeRatio: number
  /** Inner safety line, as a fraction of the half-width; closer than this → re-quote away. */
  safeDistanceRatio: number
}

export interface CorridorVerdict {
  action: 'place' | 'keep' | 'requote'
  /** The APR to rest at when placing / re-quoting. */
  targetApr: number
  reason: string
}

/** The APR an order should rest at for this side. */
export function edgeApr(mid: number, range: number, side: BorosSide, p: CorridorParams): number {
  const offset = range * p.edgeRatio
  return side === 'long' ? mid - offset : mid + offset
}

/**
 * Decide for one side. `restingApr` is the current order's APR (undefined =
 * nothing resting). Distances are measured from mid on the side's own
 * direction: an order that has crossed to the wrong side of mid is "closer
 * than zero" and must be re-quoted.
 */
export function judgeSide(args: {
  side: BorosSide
  mid: number
  range: number
  restingApr: number | undefined
  params: CorridorParams
}): CorridorVerdict {
  const { side, mid, range, restingApr, params } = args
  const target = edgeApr(mid, range, side, params)
  if (restingApr === undefined) return { action: 'place', targetApr: target, reason: 'nothing resting' }

  const distance = side === 'long' ? mid - restingApr : restingApr - mid
  if (distance > range) return { action: 'requote', targetApr: target, reason: `out of band (${fmt(distance)} > ${fmt(range)})` }
  if (distance < range * params.safeDistanceRatio) return { action: 'requote', targetApr: target, reason: `too close to mid (${fmt(distance)} < ${fmt(range * params.safeDistanceRatio)})` }
  return { action: 'keep', targetApr: target, reason: 'inside corridor' }
}

function fmt(apr: number): string {
  return `${(apr * 100).toFixed(3)}%`
}
