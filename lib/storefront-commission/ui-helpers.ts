import type { CashbackConfig } from "@/lib/cashback/config"
import { quoteStorefront } from "@/lib/cashback/quote"
import { isValidAmountInput } from "@/lib/bills/billers"
import { normalizeGhanaPhone } from "@/lib/phone-format"

/** Per-network storefront airtime terms from /api/shop/airtime/public-constraints (`cashback.<network>`). */
export interface AirtimeTerms { applied: boolean; rate: number; share: number; feeRate: number; maxFace: number | null }

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/** Defensive parse: anything unexpected means "no cashback" and the page keeps today's airtime UI. */
export function parseAirtimeTerms(constraints: unknown, network: string | null): AirtimeTerms | null {
  if (!network) return null
  const all = (constraints as { cashback?: Record<string, unknown> } | null)?.cashback
  const t = all && typeof all === "object" ? (all[network] as Partial<AirtimeTerms> | undefined) : undefined
  if (!t || t.applied !== true || !finite(t.rate) || !finite(t.share)) return null
  return { applied: true, rate: t.rate, share: t.share, feeRate: finite(t.feeRate) ? t.feeRate : 0, maxFace: finite(t.maxFace) ? t.maxFace : null }
}

export interface AirtimeStorefrontPrice {
  applied: boolean
  face: number
  pay: number
  customerCashback: number
  paymentFee: number
}

const KEY = "airtime_display"

/** Same maths as the server (quoteStorefront on a minimal config); not applied above the Hubtel cap or when the cashback rounds to nothing and there is no fee. */
export function airtimeStorefrontPrice(face: number, terms: AirtimeTerms | null): AirtimeStorefrontPrice {
  const none: AirtimeStorefrontPrice = { applied: false, face, pay: face, customerCashback: 0, paymentFee: 0 }
  if (!terms || !Number.isFinite(face) || face <= 0) return none
  if (terms.maxFace !== null && face > terms.maxFace) return none
  const s = terms.share
  // The server said cashback applies (`terms.applied`). A shop-only split (customer share 0) is still applied there:
  // a placeholder shop share keeps the quote applied here too. It never changes the customer's price (face + fee).
  const shopPlaceholder = s > 0 ? 0 : 1
  const cfg: CashbackConfig = {
    enabled: true,
    surfaces: { dashboard: true, bots: true, storefront: true, api: true },
    rates: { [`${KEY}:hubtel`]: terms.rate },
    shares: {
      airtime: { customer: s, dealer: s, storefrontCustomer: s, storefrontShop: shopPlaceholder },
      bundles: { customer: 0, dealer: 0, storefrontCustomer: 0, storefrontShop: 0 },
      bills: { customer: 0, dealer: 0, storefrontCustomer: 0, storefrontShop: 0 },
      overrides: {},
    },
    paymentFee: { airtime: terms.feeRate, bundles: 0, bills: 0 },
    storefrontGroups: { airtime: true, bundles: false, bills: false },
  }
  const q = quoteStorefront({ serviceKey: KEY, provider: "hubtel", faceAmount: face, buyer: "customer" }, cfg)
  if (!q.applied) return none
  return { applied: true, face, pay: q.payAmount, customerCashback: q.customerCashback, paymentFee: q.paymentFee }
}

// ───────────────────────── bundles ─────────────────────────

export interface StorefrontBundle {
  value: string
  display: string
  amount: number
  category: string
  token: string
  payAmount: number
  customerCashback: number
  paymentFee: number
}
export interface StorefrontCategory { name: string; bundles: StorefrontBundle[] }

/** Defensive parse of GET /api/shop/bundles/catalog; malformed bundles are dropped. */
export function parseStorefrontCatalog(json: unknown): StorefrontCategory[] {
  const cats = (json as { categories?: unknown } | null)?.categories
  if (!Array.isArray(cats)) return []
  const out: StorefrontCategory[] = []
  for (const c of cats) {
    const name = typeof c?.name === "string" ? c.name : ""
    const list = Array.isArray(c?.bundles) ? c.bundles : []
    const bundles: StorefrontBundle[] = []
    for (const b of list) {
      if (!b || typeof b.value !== "string" || typeof b.token !== "string" || !finite(b.amount) || !finite(b.payAmount)) continue
      bundles.push({
        value: b.value,
        display: typeof b.display === "string" ? b.display : b.value,
        amount: b.amount,
        category: typeof b.category === "string" ? b.category : name,
        token: b.token,
        payAmount: b.payAmount,
        customerCashback: finite(b.customerCashback) ? b.customerCashback : 0,
        paymentFee: finite(b.paymentFee) ? b.paymentFee : 0,
      })
    }
    if (name && bundles.length > 0) out.push({ name, bundles })
  }
  return out
}

const ghs = (n: number): string => `GHS ${n.toFixed(2)}`

/** Card price: the storefront price, and a muted "was" line only when the customer actually pays less than the list price. */
export function bundlePriceParts(b: Pick<StorefrontBundle, "amount" | "payAmount">): { now: string; was: string | null } {
  const less = Math.round(b.payAmount * 100) < Math.round(b.amount * 100)
  return { now: ghs(b.payAmount), was: less ? `was ${ghs(b.amount)}` : null }
}

/** Basic client check of the buyer details the server requires (name optional, email and Ghana phone required). */
export function validateBuyer(b: { email: string; phone: string }): string | null {
  const email = b.email.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address."
  if (!normalizeGhanaPhone(b.phone.trim())) return "Enter your phone number (a valid Ghana mobile number)."
  return null
}

// ───────────────────────── order status view ─────────────────────────

export type OrderView = "awaiting_payment" | "processing" | "delivered" | "failed" | "refunding" | "refunded"

/** What the confirmation page shows for a storefront order's { status, paymentStatus }. */
export function orderView(status: string | undefined, paymentStatus: string | undefined): OrderView {
  if (status === "completed") return "delivered"
  if (status === "refunded" || paymentStatus === "refunded") return "refunded"
  if (status === "refunding") return "refunding"
  if (status === "failed" || status === "reversed") return "failed"
  if (paymentStatus === "unpaid") return "awaiting_payment"
  return "processing"
}

export const isFinalView = (v: OrderView): boolean => v === "delivered" || v === "failed" || v === "refunding" || v === "refunded"

// ───────────────────────── bills ─────────────────────────

export interface BillerTermsView { applied: boolean; rate: number; share: number; feeRate: number }
export interface StorefrontBiller {
  key: string
  label: string
  logo: string
  inputHint: string
  page: "bills" | "broadband"
  min: number
  max: number
  terms: BillerTermsView
}

/** Defensive parse of availability.bills.billers; malformed entries are dropped. */
export function parseStorefrontBillers(json: unknown): StorefrontBiller[] {
  if (!Array.isArray(json)) return []
  const out: StorefrontBiller[] = []
  for (const b of json) {
    if (!b || typeof b.key !== "string" || typeof b.label !== "string" || !finite(b.min) || !finite(b.max)) continue
    const t = b.terms ?? {}
    out.push({
      key: b.key,
      label: b.label,
      logo: typeof b.logo === "string" ? b.logo : `/billers/${b.key}.png`,
      inputHint: typeof b.inputHint === "string" ? b.inputHint : "Account number",
      page: b.page === "broadband" ? "broadband" : "bills",
      min: b.min,
      max: b.max,
      terms: {
        applied: t.applied === true && finite(t.rate) && finite(t.share),
        rate: finite(t.rate) ? t.rate : 0,
        share: finite(t.share) ? t.share : 0,
        feeRate: finite(t.feeRate) ? t.feeRate : 0,
      },
    })
  }
  return out
}

export interface BillStorefrontPrice { pay: number; customerCashback: number; paymentFee: number }

/** Same maths as the server (quoteStorefront on a minimal config): face - customer cashback + payment fee. */
export function billStorefrontPrice(face: number, billerKey: string, terms: BillerTermsView): BillStorefrontPrice {
  const none: BillStorefrontPrice = { pay: face, customerCashback: 0, paymentFee: 0 }
  if (!Number.isFinite(face) || face <= 0) return none
  const serviceKey = `bill_${billerKey}`
  const s = terms.applied ? terms.share : 0
  const cfg: CashbackConfig = {
    enabled: true,
    surfaces: { dashboard: true, bots: true, storefront: true, api: true },
    rates: { [`${serviceKey}:hubtel`]: terms.applied ? terms.rate : 0 },
    shares: {
      airtime: { customer: 0, dealer: 0, storefrontCustomer: 0, storefrontShop: 0 },
      bundles: { customer: 0, dealer: 0, storefrontCustomer: 0, storefrontShop: 0 },
      bills: { customer: s, dealer: s, storefrontCustomer: s, storefrontShop: 0 },
      overrides: {},
    },
    paymentFee: { airtime: 0, bundles: 0, bills: terms.feeRate },
    storefrontGroups: { airtime: false, bundles: false, bills: true },
  }
  const q = quoteStorefront({ serviceKey, provider: "hubtel", faceAmount: face, buyer: "customer" }, cfg)
  return { pay: q.payAmount, customerCashback: q.customerCashback, paymentFee: q.paymentFee }
}

/** Amount field check: up to 2 decimals and within the biller's limits. Returns the number or null. */
export function parseBillAmount(input: string, min: number, max: number): number | null {
  if (!isValidAmountInput(input.trim())) return null
  const n = Number(input)
  return Number.isFinite(n) && n >= min && n <= max ? n : null
}

/** "20.00" for the amount field, or "" when there is nothing due. */
export function suggestedAmountText(suggested: unknown): string {
  return finite(suggested) && suggested > 0 ? suggested.toFixed(2) : ""
}

export interface StorefrontMeter { meter: string; name: string | null; outstanding: number | null; token: string }

/** Defensive parse of /api/shop/bills/verify (names arrive masked). */
export function parseBillVerify(json: unknown):
  | { ok: true; token: string | null; name: string | null; due: number | null; suggested: number; meters: StorefrontMeter[] }
  | { ok: false; error: string } {
  const j = json as Record<string, any> | null
  if (!j || j.success !== true) return { ok: false, error: typeof j?.error === "string" && j.error ? j.error : "Could not verify. Please try again." }
  const meters: StorefrontMeter[] = []
  if (Array.isArray(j.meters)) {
    for (const m of j.meters) {
      if (typeof m?.meter !== "string" || typeof m?.token !== "string") continue
      meters.push({ meter: m.meter, name: typeof m.name === "string" ? m.name : null, outstanding: finite(m.outstanding) ? m.outstanding : null, token: m.token })
    }
  }
  return {
    ok: true,
    token: typeof j.token === "string" ? j.token : null,
    name: typeof j.customerName === "string" ? j.customerName : null,
    due: finite(j.amountDue) ? j.amountDue : null,
    suggested: finite(j.suggestedAmount) ? j.suggestedAmount : 0,
    meters,
  }
}

// ───────────────────────── payer-phone OTP ─────────────────────────

/** True when an initialize response says the payer's phone must be OTP-verified first. */
export function isOtpRequiredResponse(status: number, json: unknown): boolean {
  return status === 403 && (json as { code?: unknown } | null)?.code === "OTP_REQUIRED"
}

/** A phone the OTP routes will accept (0XXXXXXXXX / XXXXXXXXX / 233...). */
export function isOtpPhone(phone: string): boolean {
  return normalizeGhanaPhone(phone.trim()) !== null
}

// ───────────────────────── direct MoMo charge ─────────────────────────

/** Same prefix map payments/initialize uses to pick the Paystack MoMo provider (mtn / vod / tgo). */
const MOMO_NETWORK: Record<string, string> = {
  "024": "MTN MoMo", "025": "MTN MoMo", "053": "MTN MoMo", "054": "MTN MoMo", "055": "MTN MoMo", "059": "MTN MoMo",
  "020": "Telecel Cash", "050": "Telecel Cash",
  "026": "AT Money", "027": "AT Money", "056": "AT Money", "057": "AT Money",
}

/** Mobile Money network the payment prompt goes to, or null when the number is not a MoMo number we can charge. */
export function momoNetworkLabel(phone: string): string | null {
  const local = normalizeGhanaPhone(phone.trim())
  return local ? MOMO_NETWORK[local.slice(0, 3)] ?? null : null
}

/** payments/initialize refused momoDirect because direct charge is off now (stale page): use the hosted checkout. */
export function isDirectChargeOffResponse(status: number, json: unknown): boolean {
  return status === 400 && (json as { code?: unknown } | null)?.code === "DIRECT_CHARGE_OFF"
}

/** Bill initialize answers that mean the single-use verification is spent or invalid: the customer must verify again. */
export function billNeedsReverify(status: number, json: unknown): boolean {
  const j = json as { error?: unknown; quote?: unknown } | null
  if (status === 409) return !j?.quote
  return status === 400 && typeof j?.error === "string" && /verify/i.test(j.error)
}
