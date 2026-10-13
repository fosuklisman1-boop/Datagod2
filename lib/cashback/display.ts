import type { CashbackConfig } from "./config"
import { quoteCashback } from "./quote"

/** One service's entry in the /api/cashback/rates response. */
export interface RateEntry {
  provider: string
  rate: number
  /** Percent of the commission the caller's tier receives. */
  share: number
  /** Hubtel per-request cap on the face amount; above it the server gives no cashback. */
  maxFace?: number
}
export interface RatesResponse { applied: boolean; services: Record<string, RateEntry> }

export interface DisplayQuote { pay: number; cashback: number; applied: boolean }

const KEY = "airtime_display"

/** Same maths as the server: a minimal config fed through quoteCashback (no duplicated rounding). */
export function quoteForDisplay(face: number, entry: RateEntry | undefined): DisplayQuote {
  const none: DisplayQuote = { pay: face, cashback: 0, applied: false }
  if (!entry || !Number.isFinite(face) || face <= 0) return none
  if (entry.maxFace !== undefined && face > entry.maxFace) return none
  if (entry.provider !== "hubtel" && entry.provider !== "digiwapy") return none
  const s = entry.share
  const cfg: CashbackConfig = {
    enabled: true,
    surfaces: { dashboard: true, bots: true, storefront: true, api: true },
    rates: { [`${KEY}:${entry.provider}`]: entry.rate },
    shares: {
      airtime: { customer: s, dealer: s, storefrontCustomer: s, storefrontShop: 0 },
      bundles: { customer: 0, dealer: 0, storefrontCustomer: 0, storefrontShop: 0 },
      bills: { customer: 0, dealer: 0, storefrontCustomer: 0, storefrontShop: 0 },
      overrides: {},
    },
  }
  const q = quoteCashback({ serviceKey: KEY, provider: entry.provider, faceAmount: face, buyer: "customer", channel: "dashboard" }, cfg)
  return q.applied ? { pay: q.payAmount, cashback: q.customerCashback, applied: true } : none
}

const ghs = (n: number): string => `GHS ${n.toFixed(2)}`

/** "GHS 2.90 (was GHS 3.00)" when cashback applies, else "GHS 3.00". */
export function priceLabel(face: number, q: DisplayQuote): string {
  return q.applied ? `${ghs(q.pay)} (was ${ghs(face)})` : ghs(face)
}

/** How much more the user needs to pay, or null when the balance covers it. */
export function shortfall(balance: number, pay: number): number | null {
  const gap = Math.round((pay - balance) * 100) / 100
  return gap > 0 ? gap : null
}
