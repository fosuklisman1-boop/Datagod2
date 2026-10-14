import type { CashbackConfig } from "@/lib/cashback/config"
import { quoteStorefront } from "@/lib/cashback/quote"
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
  const cfg: CashbackConfig = {
    enabled: true,
    surfaces: { dashboard: true, bots: true, storefront: true, api: true },
    rates: { [`${KEY}:hubtel`]: terms.rate },
    shares: {
      airtime: { customer: s, dealer: s, storefrontCustomer: s, storefrontShop: 0 },
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

export type OrderView = "awaiting_payment" | "processing" | "delivered" | "failed"

/** What the confirmation page shows for a storefront order's { status, paymentStatus }. */
export function orderView(status: string | undefined, paymentStatus: string | undefined): OrderView {
  if (status === "completed") return "delivered"
  if (status === "failed" || status === "reversed" || status === "refunded") return "failed"
  if (paymentStatus === "unpaid") return "awaiting_payment"
  return "processing"
}

export const isFinalView = (v: OrderView): boolean => v === "delivered" || v === "failed"
