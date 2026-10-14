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

/** priceLabel split for layouts that style the old price apart: { now: "GHS 2.90", was: "was GHS 3.00" | null }. */
export function priceParts(face: number, q: DisplayQuote): { now: string; was: string | null } {
  return q.applied ? { now: ghs(q.pay), was: `was ${ghs(face)}` } : { now: ghs(face), was: null }
}

/** "Midnight Bundles · 8.48 GB" (the reference's "You receive"); just the display without a category. */
export function bundleReceiveLabel(category: string | undefined, display: string): string {
  const c = (category ?? "").trim()
  return c ? `${c} · ${display}` : display
}

/** How much more the user needs to pay, or null when the balance covers it. */
export function shortfall(balance: number, pay: number): number | null {
  const gap = Math.round((pay - balance) * 100) / 100
  return gap > 0 ? gap : null
}

/** Rates older than this are re-fetched before a pay/confirm step opens. */
export const RATES_MAX_AGE_MS = 5 * 60_000

export function ratesStale(fetchedAt: number | null, now: number): boolean {
  return fetchedAt === null || now < fetchedAt || now - fetchedAt >= RATES_MAX_AGE_MS
}

export const NO_RATES: RatesResponse = { applied: false, services: {} }

/** Defensive parse of /api/cashback/rates: anything unexpected means "no cashback" (the server decides at pay time). */
export function parseRates(json: unknown): RatesResponse {
  const services = (json as { services?: unknown } | null)?.services
  if (!services || typeof services !== "object") return NO_RATES
  const out: Record<string, RateEntry> = {}
  for (const [key, v] of Object.entries(services as Record<string, unknown>)) {
    const e = v as Partial<RateEntry> | null
    if (!e || typeof e.provider !== "string" || !Number.isFinite(e.rate) || !Number.isFinite(e.share)) continue
    const entry: RateEntry = { provider: e.provider, rate: Number(e.rate), share: Number(e.share) }
    if (typeof e.maxFace === "number" && Number.isFinite(e.maxFace)) entry.maxFace = e.maxFace
    out[key] = entry
  }
  return { applied: Object.keys(out).length > 0, services: out }
}

/** Rates key for dashboard airtime ("MTN" | "Telecel" | "AT"). */
export function airtimeServiceKey(network: string): string {
  return `airtime_${network.toLowerCase()}`
}

export interface PriceChange {
  message: string
  faceAmount: number
  payAmount: number
  customerCashback: number
  /** Airtime legacy breakdown behind payAmount, when the server sent it. */
  airtimeAmount?: number
  feeAmount?: number
  feeRate?: number
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/** A 409 that carries a `quote` is "the price changed": definitely not charged, show the new price and ask again. */
export function parsePriceChange(status: number, json: unknown): PriceChange | null {
  if (status !== 409) return null
  const j = json as { error?: unknown; quote?: Record<string, unknown> } | null
  const q = j?.quote
  if (!q || !finite(q.payAmount)) return null
  const face = finite(q.faceAmount) ? q.faceAmount : q.payAmount
  const message = typeof j?.error === "string" && j.error ? j.error : "The price has changed. Please review the new price."
  const cashback = finite(q.customerCashback) ? q.customerCashback : 0
  const out: PriceChange = { message, faceAmount: face, payAmount: q.payAmount, customerCashback: cashback }
  if (finite(q.airtimeAmount)) out.airtimeAmount = q.airtimeAmount
  if (finite(q.feeAmount)) out.feeAmount = q.feeAmount
  if (finite(q.feeRate)) out.feeRate = q.feeRate
  return out
}

/** "GHS 10.00 MTN airtime" */
export function airtimeReceiveLabel(networkLabel: string, face: number): string {
  return `${ghs(face)} ${networkLabel} airtime`
}

/** "ECG GHS 50.00 to 12345" */
export function billReceiveLabel(billerLabel: string, face: number, account: string): string {
  return `${billerLabel} ${ghs(face)} to ${account}`
}

/** "Balance GHS 0.90" plus the red " — GHS 2.00 short" part (null when covered). */
export function balanceLine(balance: number, pay: number): { text: string; short: string | null } {
  const gap = shortfall(balance, pay)
  return { text: `Balance ${ghs(balance)}`, short: gap === null ? null : `${ghs(gap)} short` }
}
