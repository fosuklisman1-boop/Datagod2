import { quoteBots, type StorefrontQuote } from "@/lib/cashback/quote"
import { BILLERS, type BillerKey } from "@/lib/bills/billers"
import { checkBillAmount } from "@/lib/bills/config"
import { billTokenHash, type BillsDeps } from "@/lib/bills/service"
import { verifyBillToken } from "@/lib/bills/token"
import type { BundleNetwork } from "@/lib/standard-bundles/categories"
import { isValidIdempotencyKey, prepareBundlePurchase, PRICES_REFRESHED, type BundlesDeps } from "@/lib/standard-bundles/service"
import { verifyBundleToken } from "@/lib/standard-bundles/token"
import { insertBillOnce, toInitializeResult, type InitializeResult, type PriceQuote, type StorefrontOrderRow } from "@/lib/storefront-commission/bills"
import { insertBundleOnce } from "@/lib/storefront-commission/bundles"
import {
  fail, parseAmount, parseExpectedPay, priceMatches, NOT_AVAILABLE, PRICE_UPDATED, UNAVAILABLE, type Fail,
} from "@/lib/storefront-commission/shop"
import { botBundlesCfg } from "./catalog"
import { checkBotPendingCaps, type BotCapDeps } from "./caps"
import { botBinding, resolveBotContext, type BotContext, type BotSurface, type ResolvedBotContext } from "./context"
import { botBillGate } from "./verify"

/** The columns a bot order result is built from (same as the storefront initialize row). */
export type BotOrderRow = StorefrontOrderRow

/** Cashback snapshot written on every bot order (null when cashback is not applied). */
interface Snapshot {
  cashback_amount: number | null; shop_share_amount: number | null; cashback_rate: number | null
  cashback_share: number | null; cashback_provider: string | null; expected_commission: number | null
}
/** Columns shared by bot bill and bundle rows (service role; user_id NULL; buyer = the dialing / WhatsApp number). */
interface BotOrderBase extends Snapshot {
  reference_code: string; user_id: null; channel: "bots"; bot_surface: BotSurface; shop_id: string | null
  amount: number; paid_amount: number; payment_fee_amount: number
  status: "pending"; payment_status: "unpaid"
  buyer_name: null; buyer_email: null; buyer_phone: string
}

export interface BotBillInsert extends BotOrderBase {
  biller: BillerKey; account_number: string; phone: string | null; email: string | null; broadband_account: string | null
  session_id: string | null; customer_name: string | null; verified: boolean
  verify_token_hash: string
  verified_at: string
}

export interface BotBundleInsert extends BotOrderBase {
  network: BundleNetwork; service_key: string; beneficiary_phone: string
  bundle_value: string; bundle_display: string; bundle_category: string
  /** Deduped by uq_hubtel_data_orders_bots_idem (bot_surface, buyer_phone, idempotency_key) WHERE channel='bots'. */
  idempotency_key: string
}

export interface BotBillsDeps extends BillsDeps {
  /** Throws with `code: "23505"` on a unique violation (verify_token_hash or reference_code). */
  insertBotBillOrder(row: BotBillInsert): Promise<BotOrderRow>
  /** The bot order (channel 'bots') this buyer created from the verify token with this hash, or null. Throws on read error. */
  findBotBillOrderByHash(botSurface: BotSurface, buyerPhone: string, verifyTokenHash: string): Promise<BotOrderRow | null>
  caps: BotCapDeps
}

export interface BotBundlesDeps extends BundlesDeps {
  /** The bot order (channel 'bots') for (surface, buyer 233 phone, key), or null. Throws on read error. */
  findBotBundleOrder(botSurface: BotSurface, buyerPhone: string, idempotencyKey: string): Promise<BotOrderRow | null>
  /** Throws with `code: "23505"` on a unique violation. */
  insertBotBundleOrder(row: BotBundleInsert): Promise<BotOrderRow>
  caps: BotCapDeps
}

export interface BotOrder { id: string; reference: string; payAmount: number; faceAmount: number; customerCashback: number; paymentFee: number }
export type BotOrderResult = { ok: true; order: BotOrder } | (Fail & { quote?: PriceQuote })

const toOrder = (r: InitializeResult): BotOrder => ({
  id: r.orderId, reference: r.reference, payAmount: r.payAmount, faceAmount: r.faceAmount,
  customerCashback: r.customerCashback, paymentFee: r.paymentFee,
})
const done = (r: { ok: true; value: InitializeResult } | Fail): BotOrderResult => (r.ok ? { ok: true, order: toOrder(r.value) } : r)

const quoteFor = (c: ResolvedBotContext, serviceKey: string, face: number, cfg: Parameters<typeof quoteBots>[1]): StorefrontQuote =>
  quoteBots({ serviceKey, provider: "hubtel", faceAmount: face, rail: c.rail, shop: c.shopId !== null }, cfg)

/** Snapshot of the quote. A main-bot order (no shop) never carries a shop share. */
function snapshot(q: StorefrontQuote, shopId: string | null): Snapshot {
  if (!q.applied) {
    return { cashback_amount: null, shop_share_amount: null, cashback_rate: null, cashback_share: null, cashback_provider: null, expected_commission: null }
  }
  return {
    cashback_amount: q.customerCashback,
    shop_share_amount: shopId !== null ? q.shopShare : 0,
    cashback_rate: q.rate,
    cashback_share: q.share,
    cashback_provider: q.provider,
    expected_commission: q.commission,
  }
}

const priceChanged = (face: number, q: StorefrontQuote): Fail & { quote: PriceQuote } => ({
  ...fail(409, PRICE_UPDATED),
  quote: { faceAmount: face, payAmount: q.payAmount, customerCashback: q.customerCashback, paymentFee: q.paymentFee },
})

export interface BotBillOrderInput { token: unknown; amount: unknown; expectedPay: unknown }

/**
 * Create an UNPAID bot bill order (channel 'bots'; payment and dispatch happen after the rail confirms).
 * Every check runs before the single write; an expectedPay mismatch => 409 with the live quote, nothing written.
 * A retry with the same verify token returns the order it already created. Ghana Water from a USSD bot => 403.
 */
export async function botCreateBillOrder(d: BotBillsDeps, ctx: BotContext, input: BotBillOrderInput): Promise<BotOrderResult> {
  const r = resolveBotContext(ctx)
  if (!r.ok) return r
  const c = r.ctx
  const expectedPay = parseExpectedPay(input?.expectedPay)
  if (expectedPay === undefined) return fail(400, "expectedPay is required")
  if (!d.secret) return fail(503, UNAVAILABLE)
  const token = typeof input.token === "string" ? input.token : ""
  const v = verifyBillToken(token, d.secret, botBinding(c), d.now())
  if (!v) return fail(400, "Please verify the account again")
  const hash = billTokenHash(token)
  // A retry with the same token hands back its order before any gate or cap (never consumes a slot).
  let prior: BotOrderRow | null
  try { prior = await d.findBotBillOrderByHash(c.botSurface, c.buyerPhone, hash) } catch { return fail(503, UNAVAILABLE) }
  if (prior) return done({ ok: true, value: toInitializeResult(prior) })

  const g = await botBillGate(d, c.botSurface, v.biller)
  if (!g.ok) return g
  const amount = parseAmount(input.amount)
  const bad = checkBillAmount(g.bills.billers[v.biller], amount)
  if (bad) return fail(400, bad)
  const face = Math.round(amount * 100) / 100

  // Hubtel receives the face; the buyer pays face − cashback + this rail's fee.
  const q = quoteFor(c, BILLERS[v.biller].serviceKey, face, g.cfg)
  if (!priceMatches(expectedPay, q.payAmount)) return priceChanged(face, q)

  const capped = await checkBotPendingCaps(d.caps, "bill", "hubtel_bill_orders", c)
  if (capped) return capped

  const insert = (reference: string) => d.insertBotBillOrder({
    reference_code: reference, user_id: null, channel: "bots", bot_surface: c.botSurface, shop_id: c.shopId,
    biller: v.biller, account_number: v.account, phone: v.phone, email: v.email, broadband_account: v.broadbandAccount,
    session_id: v.sessionId, customer_name: v.customerName, verified: v.verified,
    amount: face, paid_amount: q.payAmount, payment_fee_amount: q.paymentFee,
    status: "pending", payment_status: "unpaid",
    buyer_name: null, buyer_email: null, buyer_phone: c.buyerPhone,
    ...snapshot(q, c.shopId),
    verify_token_hash: hash,
    verified_at: new Date(v.issuedAt).toISOString(),
  })
  return done(await insertBillOnce(insert, () => d.findBotBillOrderByHash(c.botSurface, c.buyerPhone, hash), () => d.newReference(), "bot-bills"))
}

export interface BotBundleOrderInput { token: unknown; recipient: unknown; idempotencyKey: unknown; expectedPay: unknown }

/**
 * Create an UNPAID bot bundle order (channel 'bots'). A repeat with the same (surface, buyer, idempotency key) returns
 * the existing order (never a second row). Every check runs before the single write; expectedPay mismatch => 409.
 */
export async function botCreateBundleOrder(d: BotBundlesDeps, ctx: BotContext, input: BotBundleOrderInput): Promise<BotOrderResult> {
  const r = resolveBotContext(ctx)
  if (!r.ok) return r
  const c = r.ctx
  if (!isValidIdempotencyKey(input?.idempotencyKey)) return fail(400, "Invalid request, please try again")
  const key = input.idempotencyKey
  let existing: BotOrderRow | null
  try { existing = await d.findBotBundleOrder(c.botSurface, c.buyerPhone, key) } catch { return fail(503, UNAVAILABLE) }
  if (existing) return done({ ok: true, value: toInitializeResult(existing) })

  const expectedPay = parseExpectedPay(input.expectedPay)
  if (expectedPay === undefined) return fail(400, "expectedPay is required")
  if (!d.secret) return fail(503, UNAVAILABLE)
  const v = verifyBundleToken(typeof input.token === "string" ? input.token : "", d.secret, d.now())
  if (!v) return fail(409, PRICES_REFRESHED)

  const g = await botBundlesCfg(d)
  if (!g.ok) return g
  // Number + prefix, Phase 2b master/network/category, Hubtel up + not paused, live re-query for the recipient.
  const prep = await prepareBundlePurchase(d, v, input.recipient)
  if (!prep.ok) return prep.status === 403 ? fail(403, NOT_AVAILABLE) : prep

  const q = quoteFor(c, prep.serviceKey, prep.amount, g.cfg)
  if (!priceMatches(expectedPay, q.payAmount)) return priceChanged(prep.amount, q)

  const capped = await checkBotPendingCaps(d.caps, "bundle", "hubtel_data_orders", c)
  if (capped) return capped

  return done(await insertBundleOnce(() => d.insertBotBundleOrder({
    reference_code: d.newReference(), user_id: null, channel: "bots", bot_surface: c.botSurface, shop_id: c.shopId,
    network: v.network, service_key: prep.serviceKey, beneficiary_phone: prep.phone233,
    bundle_value: v.value, bundle_display: v.display, bundle_category: v.category,
    amount: prep.amount, paid_amount: q.payAmount, payment_fee_amount: q.paymentFee,
    status: "pending", payment_status: "unpaid", idempotency_key: key,
    buyer_name: null, buyer_email: null, buyer_phone: c.buyerPhone,
    ...snapshot(q, c.shopId),
  }), () => d.findBotBundleOrder(c.botSurface, c.buyerPhone, key), "bot-bundles"))
}
