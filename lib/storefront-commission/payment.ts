import { randomBytes } from "crypto"

/**
 * Paystack wiring for storefront bill / bundle orders. The order types are internal codes: nothing Paystack shows or
 * stores names the product (reference, labels, description).
 */
export const STOREFRONT_ORDER_TYPES = ["cs_bill", "cs_bundle"] as const
export type StorefrontOrderType = (typeof STOREFRONT_ORDER_TYPES)[number]
export type StorefrontOrderTable = "hubtel_bill_orders" | "hubtel_data_orders"

export const STOREFRONT_ORDER_TABLE: Record<StorefrontOrderType, StorefrontOrderTable> = {
  cs_bill: "hubtel_bill_orders",
  cs_bundle: "hubtel_data_orders",
}

export function isStorefrontOrderType(t: unknown): t is StorefrontOrderType {
  return typeof t === "string" && (STOREFRONT_ORDER_TYPES as readonly string[]).includes(t)
}

/** Opaque Paystack reference: 32 hex characters, never the order's BILL-/SB- reference code. */
export function newPaystackReference(): string {
  return randomBytes(16).toString("hex")
}

/** Neutral labels for Paystack (metadata channel + the receipt "Purpose" field). */
export const STOREFRONT_PAYMENT_CHANNEL = "shop_order"
export const STOREFRONT_PAYMENT_PURPOSE = "Shop order"
/** Shop confirmation page path (relative to /shop/<slug>/); no product words. */
export const STOREFRONT_CONFIRMATION_PATH = "payment-confirmation"

/**
 * Extra Paystack fee rate added on top of the order amount at payment init. Airtime and storefront commission orders
 * add none (for the commission orders the payment fee is already inside `paid_amount`); every other type keeps the
 * admin percentage (default 3%).
 */
export function extraPaystackFeeRate(orderType: unknown, settingsPercentage: number | null | undefined): number {
  if (orderType === "airtime" || isStorefrontOrderType(orderType)) return 0
  return (settingsPercentage || 3.0) / 100
}

/** Error code payments/initialize returns when momoDirect is asked for while the direct-charge gate is off. */
export const DIRECT_CHARGE_OFF = "DIRECT_CHARGE_OFF"

export type MomoPollStatus = "pending" | "completed" | "failed"

/**
 * Direct MoMo charge polling for a storefront bill / bundle order. The order flips unpaid -> paid on confirmation (any
 * later status means it was paid). A declined / failed charge never touches the order (it stays pending + unpaid and
 * can be paid again); charge.failed and a rejected OTP mark the wallet_payments row for that reference failed instead.
 */
export function storefrontMomoStatus(orderPaymentStatus: string | null | undefined, walletPaymentStatus: string | null | undefined): MomoPollStatus {
  if (orderPaymentStatus && orderPaymentStatus !== "unpaid") return "completed"
  if (walletPaymentStatus === "failed" || walletPaymentStatus === "abandoned" || walletPaymentStatus === "cancelled") return "failed"
  return "pending"
}

export interface StorefrontPayableRow {
  channel: string | null
  shop_id: string | null
  status: string | null
  payment_status: string | null
  paid_amount: number | string | null
  buyer_email: string | null
}

export type PayableCheck =
  | { ok: true; amount: number; email: string; shopId: string }
  | { ok: false; status: number; error: string }

/**
 * Payment init for a storefront commission order: only a storefront row of this shop that is still pending AND unpaid
 * (a replayed bundle key can return an order in any state). The amount is `paid_amount` from the database; the payer
 * email is the buyer's.
 */
export function checkStorefrontPayable(row: StorefrontPayableRow | null, shopId: string | null): PayableCheck {
  if (!row || row.channel !== "storefront" || !row.shop_id) return { ok: false, status: 400, error: "Invalid order ID" }
  if (!shopId || row.shop_id !== shopId) return { ok: false, status: 400, error: "Invalid order ID" }
  if (row.status !== "pending" || row.payment_status !== "unpaid") {
    return { ok: false, status: 400, error: "This order is no longer available for payment." }
  }
  const amount = Number(row.paid_amount)
  if (row.paid_amount === null || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, status: 500, error: "Invalid order configuration" }
  }
  const email = typeof row.buyer_email === "string" ? row.buyer_email.trim() : ""
  if (!email) return { ok: false, status: 500, error: "Invalid order configuration" }
  return { ok: true, amount: Math.round(amount * 100) / 100, email, shopId: row.shop_id }
}
