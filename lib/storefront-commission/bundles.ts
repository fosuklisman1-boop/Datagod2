import type { CashbackConfig } from "@/lib/cashback/config"
import { quoteStorefront, type StorefrontQuote } from "@/lib/cashback/quote"
import { getCatalog, type SignedBundle } from "@/lib/standard-bundles/catalog"
import { NETWORK_SERVICE, type BundleNetwork } from "@/lib/standard-bundles/categories"
import {
  isValidIdempotencyKey, prepareBundlePurchase, PRICES_REFRESHED, type BundlesDeps,
} from "@/lib/standard-bundles/service"
import { verifyBundleToken } from "@/lib/standard-bundles/token"
import {
  checkPendingCaps, fail, normaliseBuyer, parseExpectedPay, priceMatches,
  storefrontGroupOn, NOT_AVAILABLE, PRICE_UPDATED, UNAVAILABLE, type CapDeps, type Fail,
} from "./shop"
import { toInitializeResult, type InitializeResult, type InitResult, type StorefrontOrderRow } from "./bills"

/** Row written for a storefront bundle order (service role; user_id NULL, buyer in buyer_*). */
export interface StorefrontBundleInsert {
  reference_code: string; user_id: null; channel: "storefront"; shop_id: string
  network: BundleNetwork; service_key: string; beneficiary_phone: string
  bundle_value: string; bundle_display: string; bundle_category: string
  amount: number; paid_amount: number; payment_fee_amount: number
  status: "pending"; payment_status: "unpaid"
  /** The raw client key; deduped per shop by uq_hubtel_data_orders_storefront_idem (shop_id, idempotency_key). */
  idempotency_key: string
  buyer_name: string | null; buyer_email: string; buyer_phone: string
  cashback_amount: number | null; shop_share_amount: number | null; cashback_rate: number | null
  cashback_share: number | null; cashback_provider: string | null; expected_commission: number | null
}

/** The columns an initialize response is built from. */
export type StorefrontBundleRow = StorefrontOrderRow

export interface StorefrontBundlesDeps extends BundlesDeps {
  findStorefrontOrder(shopId: string, idempotencyKey: string): Promise<StorefrontBundleRow | null>
  /** Throws with `code: "23505"` on a unique violation. */
  insertStorefrontOrder(row: StorefrontBundleInsert): Promise<StorefrontBundleRow>
  caps: CapDeps
}

async function storefrontBundlesCfg(d: Pick<BundlesDeps, "getCashbackConfig">): Promise<{ ok: true; cfg: CashbackConfig } | Fail> {
  let cfg: CashbackConfig
  try { cfg = await d.getCashbackConfig() } catch { return fail(503, UNAVAILABLE) }
  if (!storefrontGroupOn(cfg, "bundles")) return fail(403, NOT_AVAILABLE)
  return { ok: true, cfg }
}

export type StorefrontBundle = SignedBundle & { payAmount: number; customerCashback: number; paymentFee: number }
export type StorefrontCatalogResult =
  | { ok: true; categories: { name: string; bundles: StorefrontBundle[] }[] }
  | Fail

/** The dashboard catalog (same gates, cache and signed tokens) with the storefront price on every bundle. */
export async function storefrontCatalog(d: BundlesDeps, network: BundleNetwork): Promise<StorefrontCatalogResult> {
  return pricedCatalog(d, network, () => storefrontBundlesCfg(d),
    (cfg, serviceKey, face) => quoteStorefront({ serviceKey, provider: "hubtel", faceAmount: face, buyer: "customer" }, cfg))
}

/**
 * Pay-first catalog (storefront, bots): the surface gate (`gate`), nothing sold while Hubtel is paused, then the
 * dashboard catalog with `price` (the surface's quote) on every bundle. Switch-off answers are the vague NOT_AVAILABLE.
 */
export async function pricedCatalog(
  d: BundlesDeps, network: BundleNetwork,
  gate: () => Promise<{ ok: true; cfg: CashbackConfig } | Fail>,
  price: (cfg: CashbackConfig, serviceKey: string, face: number) => StorefrontQuote,
): Promise<StorefrontCatalogResult> {
  const g = await gate()
  if (!g.ok) return g
  try {
    const h = await d.getHubtelConfig()
    if (h?.paused) return fail(503, UNAVAILABLE) // storefront customers pay before dispatch: nothing sold while paused
  } catch { return fail(503, UNAVAILABLE) }
  const c = await getCatalog(d, network)
  if (!c.ok) return c.status === 403 ? fail(403, NOT_AVAILABLE) : c
  const serviceKey = NETWORK_SERVICE[network]
  return {
    ok: true,
    categories: c.categories.map(cat => ({
      name: cat.name,
      bundles: cat.bundles.map(b => {
        const q = price(g.cfg, serviceKey, b.amount)
        return { ...b, payAmount: q.payAmount, customerCashback: q.customerCashback, paymentFee: q.paymentFee }
      }),
    })),
  }
}

const fromRow = toInitializeResult

export interface BundleInitInput {
  token: unknown; phone: unknown; idempotencyKey: unknown; expectedPay: unknown
  customerName?: unknown; customerEmail?: unknown; customerPhone?: unknown
}

/**
 * Create an UNPAID storefront bundle order. A repeat with the same (shop, idempotency key) returns the existing order
 * (never a second row). Every check runs before the single write; an expectedPay mismatch => 409, nothing written.
 */
export async function initializeStorefrontBundle(d: StorefrontBundlesDeps, shopId: string, input: BundleInitInput): Promise<InitResult> {
  if (!isValidIdempotencyKey(input.idempotencyKey)) return fail(400, "Invalid request, please try again")
  const key = input.idempotencyKey
  let existing: StorefrontBundleRow | null
  try { existing = await d.findStorefrontOrder(shopId, key) } catch { return fail(503, UNAVAILABLE) }
  if (existing) return { ok: true, value: fromRow(existing) }

  const b = normaliseBuyer(input)
  if (!b.ok) return b
  const expectedPay = parseExpectedPay(input.expectedPay)
  if (expectedPay === undefined) return fail(400, "expectedPay is required")
  if (!d.secret) return fail(503, UNAVAILABLE)
  const v = verifyBundleToken(typeof input.token === "string" ? input.token : "", d.secret, d.now())
  if (!v) return fail(409, PRICES_REFRESHED)

  const g = await storefrontBundlesCfg(d)
  if (!g.ok) return g
  // Number + prefix, Phase 2b master/network/category, Hubtel up + not paused, live re-query for the recipient.
  const prep = await prepareBundlePurchase(d, v, input.phone)
  if (!prep.ok) return prep.status === 403 ? fail(403, NOT_AVAILABLE) : prep

  const q = quoteStorefront({ serviceKey: prep.serviceKey, provider: "hubtel", faceAmount: prep.amount, buyer: "customer" }, g.cfg)
  if (!priceMatches(expectedPay, q.payAmount)) {
    return {
      ...fail(409, PRICE_UPDATED),
      quote: { faceAmount: prep.amount, payAmount: q.payAmount, customerCashback: q.customerCashback, paymentFee: q.paymentFee },
    }
  }

  const capped = await checkPendingCaps(d.caps, "bundle", "hubtel_data_orders", { email: b.buyer.email, phone: b.buyer.phone, shopId })
  if (capped) return capped

  return insertBundleOnce(() => d.insertStorefrontOrder({
      reference_code: d.newReference(), user_id: null, channel: "storefront", shop_id: shopId,
      network: v.network, service_key: prep.serviceKey, beneficiary_phone: prep.phone233,
      bundle_value: v.value, bundle_display: v.display, bundle_category: v.category,
      amount: prep.amount, paid_amount: q.payAmount, payment_fee_amount: q.paymentFee,
      status: "pending", payment_status: "unpaid", idempotency_key: key,
      buyer_name: b.buyer.name, buyer_email: b.buyer.email, buyer_phone: b.buyer.phone,
      cashback_amount: q.applied ? q.customerCashback : null,
      shop_share_amount: q.applied ? q.shopShare : null,
      cashback_rate: q.applied ? q.rate : null,
      cashback_share: q.applied ? q.share : null,
      cashback_provider: q.applied ? q.provider : null,
      expected_commission: q.applied ? q.commission : null,
    }), () => d.findStorefrontOrder(shopId, key), "storefront-bundles")
}

/**
 * The single write of a pay-first bundle order, idempotent on its key: on a unique violation a concurrent request
 * with the same key won the insert => hand back its order (`findWinner`). Anything else => 503, nothing written.
 */
export async function insertBundleOnce(
  insert: () => Promise<StorefrontBundleRow>,
  findWinner: () => Promise<StorefrontBundleRow | null>,
  tag: string,
): Promise<{ ok: true; value: InitializeResult } | Fail> {
  let row: StorefrontBundleRow
  try {
    row = await insert()
  } catch (e: any) {
    if (e?.code === "23505") {
      // A concurrent request with the same key won the insert: hand back its order.
      let won: StorefrontBundleRow | null = null
      try { won = await findWinner() } catch { won = null }
      if (won) return { ok: true, value: fromRow(won) }
    }
    console.error(`[${tag}] insert failed:`, e?.message ?? e)
    return fail(503, "Could not create the order — please try again.")
  }
  return { ok: true, value: fromRow(row) }
}
