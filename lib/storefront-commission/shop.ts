import type { SupabaseClient } from "@supabase/supabase-js"
import { shopHandleOrFilter } from "@/lib/shop-handle"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import type { CashbackConfig, CashbackGroup } from "@/lib/cashback/config"
import { quoteStorefront, samePrice } from "@/lib/cashback/quote"
import { BILLERS, type BillerKey } from "@/lib/bills/billers"
import type { BillsAvailability } from "@/lib/bills/runtime"
import type { BundlesAvailability } from "@/lib/standard-bundles/runtime"
import { storefrontAirtimeOn } from "@/lib/cashback/storefront-airtime"

/** Storefront group switch: master AND storefront surface AND the group's "sell on storefronts" switch. */
export const storefrontGroupOn = (cfg: CashbackConfig, group: CashbackGroup): boolean =>
  cfg.enabled === true && cfg.surfaces?.storefront === true && cfg.storefrontGroups?.[group] === true

export type Fail = { ok: false; status: number; error: string }
export const fail = (status: number, error: string): Fail => ({ ok: false, status, error })
/** Deliberately vague: a public endpoint never says which switch is off. */
export const NOT_AVAILABLE = "Not available"
export const UNAVAILABLE = "Temporarily unavailable"
export const PRICE_UPDATED = "Price updated — please review"

/**
 * Active shop by its public handle (subdomain or legacy slug), or null. A handle matching more than one shop
 * (one shop's subdomain = another's slug) is ambiguous => null, never a silent pick. Never throws.
 */
export async function resolveShop(db: SupabaseClient, handle: unknown): Promise<{ id: string } | null> {
  if (typeof handle !== "string" || !handle.trim()) return null
  try {
    const { data, error } = await db
      .from("user_shops")
      .select("id")
      .or(shopHandleOrFilter(handle.trim()))
      .eq("is_active", true)
      .limit(2)
    if (error || !Array.isArray(data) || data.length !== 1) return null
    return { id: (data[0] as { id: string }).id }
  } catch {
    return null
  }
}

// ───────────────────────── availability ─────────────────────────

/** Shop-facing pricing terms for one biller (the page computes "You pay"; expectedPay + 409 cover drift). */
export interface BillerTerms { applied: boolean; rate: number; share: number; feeRate: number }
export interface StorefrontAvailability {
  /** Storefront airtime is priced with cashback (terms per network come from /api/shop/airtime/public-constraints). */
  airtime: boolean
  bundles: { enabled: boolean; networks: BundlesAvailability["networks"] }
  bills: { enabled: boolean; billers: (BillsAvailability["billers"][number] & { terms: BillerTerms })[] }
}
export const NOTHING_AVAILABLE: StorefrontAvailability = {
  airtime: false, bundles: { enabled: false, networks: [] }, bills: { enabled: false, billers: [] },
}

export interface AvailabilityDeps {
  getCashbackConfig(): Promise<CashbackConfig>
  /** Phase 3a master + per-biller switches (never throws). */
  getBillsAvailability(): Promise<BillsAvailability>
  /** Phase 2b master + per-network switches + Hubtel enabled + service on (never throws). */
  getBundlesAvailability(): Promise<BundlesAvailability>
  getHubtelConfig(): Promise<{ enabled: boolean; paused: boolean; services: Record<string, boolean> }>
}

/** A probe face for the terms: eligibility does not depend on face (rate <= 20 %, shares <= 100 %). */
const PROBE_FACE = 100

export function billerTerms(biller: BillerKey, cfg: CashbackConfig): BillerTerms {
  const q = quoteStorefront({ serviceKey: BILLERS[biller].serviceKey, provider: "hubtel", faceAmount: PROBE_FACE, buyer: "customer" }, cfg)
  return q.applied
    ? { applied: true, rate: q.rate, share: q.share, feeRate: q.feeRate }
    : { applied: false, rate: 0, share: 0, feeRate: q.feeRate }
}

/** What a storefront may sell right now. Any read failure => nothing available (fail closed). */
export async function loadAvailability(d: AvailabilityDeps): Promise<StorefrontAvailability> {
  let cfg: CashbackConfig
  let hubtel: Awaited<ReturnType<AvailabilityDeps["getHubtelConfig"]>>
  try {
    cfg = await d.getCashbackConfig()
    hubtel = await d.getHubtelConfig()
  } catch {
    return structuredClone(NOTHING_AVAILABLE)
  }
  const out = structuredClone(NOTHING_AVAILABLE)
  out.airtime = storefrontAirtimeOn(cfg)
  // Storefront customers pay before dispatch: while Hubtel is off or paused nothing new is sold.
  const hubtelUp = hubtel?.enabled === true && hubtel.paused !== true
  if (!hubtelUp) return out

  if (storefrontGroupOn(cfg, "bills")) {
    const b = await d.getBillsAvailability()
    const billers = b.enabled
      ? b.billers
          .filter(x => hubtel.services?.[BILLERS[x.key].serviceKey] === true)
          .map(x => ({ ...x, terms: billerTerms(x.key, cfg) }))
      : []
    out.bills = { enabled: billers.length > 0, billers }
  }
  if (storefrontGroupOn(cfg, "bundles")) {
    const b = await d.getBundlesAvailability()
    out.bundles = b.enabled && b.networks.length > 0 ? { enabled: true, networks: b.networks } : { enabled: false, networks: [] }
  }
  return out
}

// ───────────────────────── request helpers ─────────────────────────

export interface Buyer { name: string | null; email: string; phone: string }
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Buyer (payer) details: email is required by the payment page, phone for refunds and the pending caps. */
export function normaliseBuyer(i: { customerName?: unknown; customerEmail?: unknown; customerPhone?: unknown }):
  { ok: true; buyer: Buyer } | Fail {
  const email = typeof i.customerEmail === "string" ? i.customerEmail.trim().toLowerCase() : ""
  if (!EMAIL.test(email) || email.length > 254) return fail(400, "Enter a valid email address")
  const phone = typeof i.customerPhone === "string" ? normalizeGhanaPhone(i.customerPhone) : null
  if (!phone) return fail(400, "Enter a valid Ghana mobile number for the payer")
  const rawName = typeof i.customerName === "string" ? i.customerName.trim().replace(/\s+/g, " ") : ""
  if (rawName.length > 100) return fail(400, "Name is too long")
  return { ok: true, buyer: { name: rawName || null, email, phone } }
}

/**
 * `expectedPay` is required on these endpoints (the page always shows a price). undefined => missing;
 * NaN => present but not a number (treated as a mismatch, like storefront airtime).
 */
export function parseExpectedPay(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined
  if (typeof v === "number") return v
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim())
  return NaN
}

export const priceMatches = (expected: number, pay: number): boolean => Number.isFinite(expected) && samePrice(expected, pay)

/** Plain positive amount: a number, or a decimal string with at most 2 places. Anything else => NaN. */
export function parseAmount(v: unknown): number {
  if (typeof v === "number") return v
  if (typeof v === "string" && /^\d+(\.\d{1,2})?$/.test(v.trim())) return Number(v.trim())
  return NaN
}

// ───────────────────────── pending-unpaid caps ─────────────────────────

export type CommissionTable = "hubtel_bill_orders" | "hubtel_data_orders"

export interface CapDeps {
  /** Atomic sliding-window limiter keyed by `id` (fails open when the limiter is unavailable). */
  limit(name: string, max: number, windowMs: number, id: string): Promise<boolean>
  /** Count of storefront rows still pending + unpaid with `column = value` created since `sinceIso`. Errors => 0. */
  countPending(table: CommissionTable, column: "buyer_email" | "buyer_phone" | "shop_id", value: string, sinceIso: string): Promise<number>
  now(): number
}

const HOUR = 60 * 60 * 1000
const FIVE_MIN = 5 * 60 * 1000
export const TOO_MANY_PENDING = "Too many pending orders. Please complete or wait for existing orders to expire."
export const TOO_MANY_PENDING_SHOP = "Too many pending orders for this shop. Please try again shortly."

/**
 * Mirrors storefront airtime: per buyer email 5/h, per buyer phone 5/h, per shop 15/5 min and 60/h — an atomic
 * limiter first (closes the count→insert race) and the DB counts as the backup when the limiter is down.
 */
export async function checkPendingCaps(
  d: CapDeps, kind: "bill" | "bundle", table: CommissionTable, k: { email: string; phone: string; shopId: string },
): Promise<Fail | null> {
  const [e, p, s5, s60] = await Promise.all([
    d.limit(`shop_${kind}_cap_email`, 5, HOUR, `e:${k.email}`),
    d.limit(`shop_${kind}_cap_phone`, 5, HOUR, `p:${k.phone}`),
    d.limit(`shop_${kind}_cap_shop_5m`, 15, FIVE_MIN, `s:${k.shopId}`),
    d.limit(`shop_${kind}_cap_shop_1h`, 60, HOUR, `s:${k.shopId}`),
  ])
  if (!e || !p) return fail(429, TOO_MANY_PENDING)
  if (!s5 || !s60) return fail(429, TOO_MANY_PENDING_SHOP)

  const now = d.now()
  const hourAgo = new Date(now - HOUR).toISOString()
  const fiveAgo = new Date(now - FIVE_MIN).toISOString()
  const [byEmail, byPhone, byShop5, byShop60] = await Promise.all([
    d.countPending(table, "buyer_email", k.email, hourAgo),
    d.countPending(table, "buyer_phone", k.phone, hourAgo),
    d.countPending(table, "shop_id", k.shopId, fiveAgo),
    d.countPending(table, "shop_id", k.shopId, hourAgo),
  ])
  if (byEmail >= 5 || byPhone >= 5) return fail(429, TOO_MANY_PENDING)
  if (byShop5 >= 15 || byShop60 >= 60) return fail(429, TOO_MANY_PENDING_SHOP)
  return null
}

// ───────────────────────── order status ─────────────────────────

const REF = /^[A-Za-z0-9-]{4,40}$/
export const isValidOrderRef = (v: unknown): v is string => typeof v === "string" && REF.test(v)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isValidOrderId = (v: unknown): v is string => typeof v === "string" && UUID.test(v)

/**
 * Status of a storefront bill/bundle order of this shop, by its reference or (the Paystack return page) its id.
 * null when not found. Throws on read error.
 */
export async function getStorefrontOrderStatus(
  db: SupabaseClient, shopId: string, ref: string | { orderId: string },
): Promise<{ status: string; paymentStatus: string } | null> {
  const [column, value] = typeof ref === "string" ? (["reference_code", ref] as const) : (["id", ref.orderId] as const)
  for (const table of ["hubtel_bill_orders", "hubtel_data_orders"] as const) {
    const { data, error } = await db
      .from(table)
      .select("status, payment_status")
      .eq(column, value)
      .eq("shop_id", shopId)
      .eq("channel", "storefront")
      .maybeSingle()
    if (error) throw error
    if (data) {
      const row = data as { status: string; payment_status: string }
      return { status: row.status, paymentStatus: row.payment_status }
    }
  }
  return null
}
