import { privateKeyToAccount } from 'viem/accounts'
import { OwAccount } from '@openwhaleorg/core'

const API = 'https://api-v2.pendle.finance/core'

export interface PendleValuation {
  chainId: number
  marketId: string
  kind: 'pt' | 'yt' | 'lp'
  balance: string
  usd: number
}

interface RawSide { valuation?: number; balance?: string }
interface RawOpenPosition { marketId?: string; pt?: RawSide; yt?: RawSide; lp?: RawSide }
interface RawChainPositions { chainId?: number; openPositions?: RawOpenPosition[] }

function normalizeKey(key: string): `0x${string}` {
  return (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`
}

/**
 * The (pendle/market, pendle) cell's session — Pendle V2 (PT/YT/LP) through
 * the hosted API, read-only in v0. Trading V2 goes through unsigned router
 * calldata + the shared web3 signer when a strategy needs it; nothing here
 * ever touches the key beyond deriving the address.
 */
export class PendleMarketSession {
  readonly address?: `0x${string}`

  constructor(options: { privateKey?: string } = {}) {
    if (options.privateKey !== undefined && options.privateKey.length > 0) {
      this.address = privateKeyToAccount(normalizeKey(options.privateKey)).address
    }
  }

  private subject(explicit?: string): string {
    const address = explicit ?? this.address
    if (!address) throw new Error('Keyless Pendle session: pass the address to read explicitly')
    return address
  }

  /** Open PT/YT/LP valuations across chains, USD-valued by the Pendle API. */
  async positions(address?: string): Promise<PendleValuation[]> {
    const subject = this.subject(address)
    const res = await fetch(`${API}/v1/dashboard/positions/database/${subject}?filterUsd=0.01`)
    if (!res.ok) throw new Error(`Pendle positions API ${res.status}`)
    const body = await res.json() as { positions?: RawChainPositions[] }
    const out: PendleValuation[] = []
    for (const chain of body.positions ?? []) {
      for (const pos of chain.openPositions ?? []) {
        for (const kind of ['pt', 'yt', 'lp'] as const) {
          const side = pos[kind]
          if (side?.valuation !== undefined && side.valuation !== 0) {
            out.push({
              chainId: chain.chainId ?? 0,
              marketId: pos.marketId ?? '?',
              kind,
              balance: side.balance ?? '0',
              usd: side.valuation,
            })
          }
        }
      }
    }
    return out
  }

  async close(): Promise<void> {
    // plain fetch — nothing persistent
  }
}

/**
 * Read-only view of a Pendle V2 portfolio — the 'pendle/market' kind's
 * canonical Reader. Binds the SAME web3/evm wallet credential the rest of the
 * stack shares; the API values every PT/YT/LP position in USD, so equity is
 * real (unlike the raw-chain wallet view, which can only price stables).
 */
@OwAccount({ id: 'market-account', kind: 'pendle/market', venue: 'pendle', displayName: 'Pendle Account' })
export class PendleMarketAccount {
  static readonly kind = 'pendle/market' as const
  static readonly venueType = 'pendle'

  constructor(
    readonly name: string,
    protected readonly session: PendleMarketSession,
  ) {}

  async balance(): Promise<{ usd: { available: number; total: number }; tokens: Array<{ token: string; free: number; locked: number; total: number; usdValue: number }> }> {
    const positions = await this.session.positions()
    const tokens = positions.map(p => ({
      token: `${p.kind.toUpperCase()} ${p.marketId.slice(0, 10)}…@${p.chainId}`,
      free: p.usd,
      locked: 0,
      total: p.usd,
      usdValue: p.usd,
    }))
    const total = tokens.reduce((acc, t) => acc + t.usdValue, 0)
    return { usd: { available: total, total }, tokens }
  }

  async snapshot(): Promise<{ equity: number }> {
    const positions = await this.session.positions()
    return { equity: positions.reduce((acc, p) => acc + p.usd, 0) }
  }
}
