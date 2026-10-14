import type { CashbackConfig } from "@/lib/cashback/config"
import { quoteStorefront } from "@/lib/cashback/quote"
import { BILLERS, isBillerKey, type BillerKey, type BillInputs } from "@/lib/bills/billers"
import { checkBillAmount, type BillsConfig } from "@/lib/bills/config"
import { billTokenHash, billsGate, billsHubtelGate, verifyBill, type BillsDeps, type VerifyResult } from "@/lib/bills/service"
import { verifyBillToken } from "@/lib/bills/token"
import {
  checkPendingCaps, fail, normaliseBuyer, parseAmount, parseExpectedPay, priceMatches,
  storefrontGroupOn, NOT_AVAILABLE, PRICE_UPDATED, UNAVAILABLE, type CapDeps, type Fail,
} from "./shop"

/** Verify tokens issued on a storefront are bound to that shop: they cannot initialize at another shop. */
export const shopBinding = (shopId: string): string => "shop:" + shopId

/** Row written for a storefront bill order (service role; user_id NULL, buyer in buyer_*). */
export interface StorefrontBillInsert {
  reference_code: string; user_id: null; channel: "storefront"; shop_id: string
  biller: BillerKey; account_number: string; phone: string | null; email: string | null; broadband_account: string | null
  session_id: string | null; customer_name: string | null; verified: boolean
  amount: number; paid_amount: number; payment_fee_amount: number
  status: "pending"; payment_status: "unpaid"
  buyer_name: string | null; buyer_email: string; buyer_phone: string
  cashback_amount: number | null; shop_share_amount: number | null; cashback_rate: number | null
  cashback_share: number | null; cashback_provider: string | null; expected_commission: number | null
  verify_token_hash: string
}

export interface StorefrontBillsDeps extends BillsDeps {
  /** Throws with `code: "23505"` on a unique violation (verify_token_hash reuse). */
  insertStorefrontOrder(row: StorefrontBillInsert): Promise<{ id: string; reference_code: string }>
  caps: CapDeps
}

export interface InitializeResult {
  orderId: string; reference: string; payAmount: number; faceAmount: number; customerCashback: number; paymentFee: number
}
export type PriceQuote = { faceAmount: number; payAmount: number; customerCashback: number; paymentFee: number }
export type InitResult = { ok: true; value: InitializeResult } | (Fail & { quote?: PriceQuote })

/** Storefront bills switch + Phase 3a master/biller + Hubtel up for that biller. */
async function storefrontBillGate(
  d: Pick<BillsDeps, "getCashbackConfig" | "getBillsConfig" | "getHubtelConfig">, biller: BillerKey,
): Promise<{ ok: true; cfg: CashbackConfig; bills: BillsConfig } | Fail> {
  let cfg: CashbackConfig
  try { cfg = await d.getCashbackConfig() } catch { return fail(503, UNAVAILABLE) }
  if (!storefrontGroupOn(cfg, "bills")) return fail(403, NOT_AVAILABLE)
  const g = await billsGate(d, biller)
  if (!g.ok) return g.status === 403 ? fail(403, NOT_AVAILABLE) : g
  const h = await billsHubtelGate(d, biller, { checkPause: true })
  if (!h.ok) return h
  return { ok: true, cfg, bills: g.bills }
}

/** Account lookup for a storefront: the dashboard engine with a shop-bound token. */
export async function verifyStorefrontBill(
  d: BillsDeps, shopId: string, biller: string, inputs: BillInputs & { addMeter?: boolean; consent?: boolean },
): Promise<VerifyResult> {
  if (!isBillerKey(biller)) return fail(400, "Unknown biller")
  const g = await storefrontBillGate(d, biller)
  if (!g.ok) return g
  return verifyBill(d, shopBinding(shopId), biller, inputs)
}

export interface BillInitInput {
  token: unknown; amount: unknown; expectedPay: unknown
  customerName?: unknown; customerEmail?: unknown; customerPhone?: unknown
}

/**
 * Create an UNPAID storefront bill order (payment and dispatch happen after Paystack confirms).
 * Every check runs before the single write; an expectedPay mismatch => 409 with the live quote and nothing written.
 */
export async function initializeStorefrontBill(d: StorefrontBillsDeps, shopId: string, input: BillInitInput): Promise<InitResult> {
  const b = normaliseBuyer(input)
  if (!b.ok) return b
  const expectedPay = parseExpectedPay(input.expectedPay)
  if (expectedPay === undefined) return fail(400, "expectedPay is required")
  if (!d.secret) return fail(503, UNAVAILABLE)
  const token = typeof input.token === "string" ? input.token : ""
  const v = verifyBillToken(token, d.secret, shopBinding(shopId), d.now())
  if (!v) return fail(400, "Please verify the account again")

  const g = await storefrontBillGate(d, v.biller)
  if (!g.ok) return g
  const amount = parseAmount(input.amount)
  const bad = checkBillAmount(g.bills.billers[v.biller], amount)
  if (bad) return fail(400, bad)
  const face = Math.round(amount * 100) / 100

  // Hubtel receives the face; the customer pays face − cashback + payment fee.
  const q = quoteStorefront({ serviceKey: BILLERS[v.biller].serviceKey, provider: "hubtel", faceAmount: face, buyer: "customer" }, g.cfg)
  if (!priceMatches(expectedPay, q.payAmount)) {
    return {
      ...fail(409, PRICE_UPDATED),
      quote: { faceAmount: face, payAmount: q.payAmount, customerCashback: q.customerCashback, paymentFee: q.paymentFee },
    }
  }

  const capped = await checkPendingCaps(d.caps, "bill", "hubtel_bill_orders", { email: b.buyer.email, phone: b.buyer.phone, shopId })
  if (capped) return capped

  let row: { id: string; reference_code: string }
  try {
    row = await d.insertStorefrontOrder({
      reference_code: d.newReference(), user_id: null, channel: "storefront", shop_id: shopId,
      biller: v.biller, account_number: v.account, phone: v.phone, email: v.email, broadband_account: v.broadbandAccount,
      session_id: v.sessionId, customer_name: v.customerName, verified: v.verified,
      amount: face, paid_amount: q.payAmount, payment_fee_amount: q.paymentFee,
      status: "pending", payment_status: "unpaid",
      buyer_name: b.buyer.name, buyer_email: b.buyer.email, buyer_phone: b.buyer.phone,
      cashback_amount: q.applied ? q.customerCashback : null,
      shop_share_amount: q.applied ? q.shopShare : null,
      cashback_rate: q.applied ? q.rate : null,
      cashback_share: q.applied ? q.share : null,
      cashback_provider: q.applied ? q.provider : null,
      expected_commission: q.applied ? q.commission : null,
      verify_token_hash: billTokenHash(token),
    })
  } catch (e: any) {
    if (e?.code === "23505") return fail(409, "This verification was already used — please verify again")
    console.error("[storefront-bills] insert failed:", e?.message ?? e)
    return fail(500, "Could not create the order")
  }
  return {
    ok: true,
    value: {
      orderId: row.id, reference: row.reference_code, payAmount: q.payAmount, faceAmount: face,
      customerCashback: q.customerCashback, paymentFee: q.paymentFee,
    },
  }
}
