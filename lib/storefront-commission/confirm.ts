import { GHANA_WATER_MAX_AGE_MS } from "@/lib/bills/admin-dispatch"
import type { StorefrontOrderTable } from "./payment"

/** The columns confirmation needs from a storefront bill / bundle order. */
export interface StorefrontPaidOrder {
  id: string
  reference_code: string
  channel: string
  shop_id: string | null
  status: string
  payment_status: string
  paid_amount: number | string | null
  shop_share_amount: number | string | null
  payment_reference: string | null
  biller?: string | null
  created_at: string
}

export interface ConfirmDeps {
  /** Throws on a read error. */
  getOrder(table: StorefrontOrderTable, id: string): Promise<StorefrontPaidOrder | null>
  /** Guarded `unpaid -> paid` (`.eq('payment_status','unpaid')`, storefront rows only); returns rows changed. Throws on error. */
  markPaid(table: StorefrontOrderTable, id: string, patch: { paid_at: string; payment_reference: string }): Promise<number>
  /** shop_profits insert; throws the PostgREST error (with `code`) on failure. */
  insertShopProfit(row: Record<string, unknown>): Promise<void>
  /** Utility Bills auto-fulfil switch (dashboard rule reused for storefront bills). Throws on a read error. */
  billsAutoFulfil(): Promise<boolean>
  /** Re-read the order through the engine and run its dispatch (atomic pending -> processing claim; one Hubtel POST). */
  dispatch(table: StorefrontOrderTable, id: string): Promise<string>
  /** Note on a still-pending order (guarded on status pending); returns rows changed. */
  setPendingNote(table: StorefrontOrderTable, id: string, notes: string): Promise<number>
  /** `urgent` alerts keep the email fallback when SMS cannot be sent. */
  alert(message: string, urgent?: boolean): Promise<void>
  now(): number
}

export type ConfirmOutcome =
  | "confirmed"          // this call flipped unpaid -> paid
  | "already_processed"  // someone else flipped it (or a replay)
  | "amount_mismatch"    // Paystack amount != paid_amount; left unpaid, admins alerted
  | "refused"            // not a storefront order (or not found)
  | "error"              // could not read / flip; nothing changed, safe to retry

export interface ConfirmResult { outcome: ConfirmOutcome; status?: string }

const pesewas = (n: number) => Math.round(n * 100)
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const safeAlert = async (d: ConfirmDeps, m: string, urgent = false) => { try { await d.alert(m, urgent) } catch { /* never break the flow */ } }

/** A second, different Paystack payment for an order that is already paid: money to give back. */
async function alertIfDuplicatePayment(d: ConfirmDeps, order: StorefrontPaidOrder, reference: string, paid: number) {
  if (order.payment_reference && order.payment_reference !== reference) {
    await safeAlert(d, `URGENT: storefront order ${order.reference_code} (${order.id}) received a second Paystack payment ` +
      `(ref ${reference}, GHS ${paid.toFixed(2)}) after it was already paid with ref ${order.payment_reference}. Refund the duplicate in Paystack.`, true)
  }
}

/**
 * Confirms a Paystack payment for a storefront Utility Bill / Standard Bundle order. Shared by the Paystack webhook and
 * /api/payments/verify; safe to call concurrently and to replay.
 *
 * 1. Re-read the order; it must be a storefront row.
 * 2. Pesewa-exact amount check against `paid_amount`; a mismatch alerts admins and leaves the order unpaid.
 * 3. Guarded `unpaid -> paid` (+ paid_at, payment_reference). 0 rows => already processed, stop.
 * 4. Only the flipper: credit the shop share (one row per order; 23505 ignored).
 * 5. Only the flipper: dispatch through the engine's claim. Errors after the flip never un-flip the order.
 *
 * `paidAmount` is in GHS (Paystack amount / 100).
 */
export async function confirmStorefrontOrder(
  d: ConfirmDeps,
  table: StorefrontOrderTable,
  orderId: string,
  p: { paidAmount: number; reference: string },
): Promise<ConfirmResult> {
  let order: StorefrontPaidOrder | null
  try {
    order = await d.getOrder(table, orderId)
  } catch (e) {
    console.error(`[storefront-confirm] could not read ${table} ${orderId}:`, msg(e))
    return { outcome: "error" }
  }
  if (!order || order.channel !== "storefront") {
    console.warn(`[storefront-confirm] refused ${table} ${orderId}: not a storefront order`)
    return { outcome: "refused" }
  }
  const ref = order.reference_code

  // A replay of the same payment, or a second payment, for an order that is already paid.
  if (order.payment_status !== "unpaid") {
    await alertIfDuplicatePayment(d, order, p.reference, p.paidAmount)
    return { outcome: "already_processed", status: order.status }
  }

  const expected = Number(order.paid_amount)
  if (order.paid_amount === null || !Number.isFinite(expected) || !Number.isFinite(p.paidAmount) || pesewas(p.paidAmount) !== pesewas(expected)) {
    await safeAlert(d, `URGENT: storefront order ${ref} (${order.id}): Paystack amount GHS ${Number(p.paidAmount).toFixed(2)} ` +
      `does not match the order's GHS ${Number.isFinite(expected) ? expected.toFixed(2) : String(order.paid_amount)} (ref ${p.reference}). ` +
      `Not marked paid and not sent; review and refund in Paystack.`, true)
    return { outcome: "amount_mismatch", status: order.status }
  }

  let flipped: number
  try {
    flipped = await d.markPaid(table, order.id, { paid_at: new Date(d.now()).toISOString(), payment_reference: p.reference })
  } catch (e) {
    console.error(`[storefront-confirm] paid flip failed for ${ref}:`, msg(e))
    return { outcome: "error" }
  }
  if (flipped === 0) {
    let cur: StorefrontPaidOrder | null = null
    try { cur = await d.getOrder(table, order.id) } catch { cur = null }
    if (cur) await alertIfDuplicatePayment(d, cur, p.reference, p.paidAmount)
    return { outcome: "already_processed", status: cur?.status ?? order.status }
  }

  // ── Only the call that flipped the order reaches here. ──
  const share = Number(order.shop_share_amount)
  if (order.shop_id && Number.isFinite(share) && share > 0) {
    try {
      await d.insertShopProfit({
        shop_id: order.shop_id,
        [table === "hubtel_bill_orders" ? "bill_order_id" : "data_order_id"]: order.id,
        profit_amount: Math.round(share * 100) / 100,
        status: "credited",
        notes: "Cashback share",
        created_at: new Date(d.now()).toISOString(),
      })
    } catch (e: any) {
      if (e?.code !== "23505") {
        await safeAlert(d, `Storefront order ${ref}: paid, but the shop share (GHS ${share.toFixed(2)}) could not be recorded: ${msg(e)}. Credit it by hand.`, true)
      }
    }
  }

  if (order.status !== "pending") {
    await safeAlert(d, `URGENT: storefront order ${ref} was paid (ref ${p.reference}) while its status is ${order.status}. Not sent; refund it.`, true)
    return { outcome: "confirmed", status: order.status }
  }

  if (table === "hubtel_bill_orders") {
    if (order.biller === "ghana_water" && d.now() - Date.parse(order.created_at) > GHANA_WATER_MAX_AGE_MS) {
      await d.setPendingNote(table, order.id, "Not sent: Ghana Water verification expired before payment — refund instead").catch(() => 0)
      await safeAlert(d, `Storefront bill order ${ref} was paid after its Ghana Water verification expired. Not sent; refund it.`, true)
      return { outcome: "confirmed", status: "pending" }
    }
    let auto: boolean
    try { auto = await d.billsAutoFulfil() } catch { auto = false }
    if (!auto) {
      await safeAlert(d, `Storefront bill order ${ref} is paid and waiting for manual dispatch in Utility Bills.`)
      return { outcome: "confirmed", status: "pending" }
    }
  }

  try {
    const status = await d.dispatch(table, order.id)
    return { outcome: "confirmed", status }
  } catch (e) {
    await safeAlert(d, `Storefront order ${ref} is paid but dispatch failed: ${msg(e)}. Check its status before sending.`, true)
    return { outcome: "confirmed" }
  }
}

// ───────────────────────── shared by the webhook and /api/payments/verify ─────────────────────────

export interface SettleDeps extends ConfirmDeps {
  /** wallet_payments -> completed (+ amount_received, transaction id) and payment_attempts -> completed. Best effort. */
  completePaymentRecords(p: { walletPaymentId: string; reference: string; paidAmount: number; transactionId: string | null; gatewayResponse?: string | null }): Promise<void>
}

export interface SettleInput {
  table: StorefrontOrderTable
  orderId: string | null
  walletPaymentId: string
  reference: string
  /** GHS. */
  paidAmount: number
  transactionId: string | null
  gatewayResponse?: string | null
}

/** Confirm the order, then mark the payment records completed when the order is (or already was) paid. */
export async function settleStorefrontPayment(d: SettleDeps, s: SettleInput): Promise<ConfirmResult> {
  if (!s.orderId) {
    await safeAlert(d, `URGENT: storefront payment ${s.reference} (GHS ${s.paidAmount.toFixed(2)}) has no order attached. Review and refund in Paystack.`, true)
    return { outcome: "refused" }
  }
  const r = await confirmStorefrontOrder(d, s.table, s.orderId, { paidAmount: s.paidAmount, reference: s.reference })
  if (r.outcome === "refused") {
    await safeAlert(d, `URGENT: payment ${s.reference} (GHS ${s.paidAmount.toFixed(2)}) is for ${s.table} ${s.orderId}, which is not a storefront order. Not processed; review and refund in Paystack.`, true)
  }
  if (r.outcome === "confirmed" || r.outcome === "already_processed") {
    try {
      await d.completePaymentRecords({
        walletPaymentId: s.walletPaymentId, reference: s.reference, paidAmount: s.paidAmount,
        transactionId: s.transactionId, gatewayResponse: s.gatewayResponse,
      })
    } catch (e) {
      console.warn("[storefront-confirm] payment record update failed (order already confirmed):", msg(e))
    }
  }
  return r
}

export interface VerifyDeps extends SettleDeps {
  verifyPayment(reference: string): Promise<{ status: string; amount: number; transaction_id?: string | null }>
}

export interface StorefrontPaymentRow { id: string; status: string | null; order_id: string | null }

/**
 * /api/payments/verify for a storefront commission order. Response shapes mirror the existing route. Throws when
 * Paystack cannot be reached (the route maps it to 500, as today).
 */
export async function verifyStorefrontPayment(
  d: VerifyDeps,
  table: StorefrontOrderTable,
  payment: StorefrontPaymentRow,
  reference: string,
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  // Payment records are completed only after the order was confirmed, so this is a finished payment.
  if (payment.status === "completed") {
    return { httpStatus: 200, body: { success: true, status: "completed", message: "Payment already verified and completed" } }
  }
  const v = await d.verifyPayment(reference)
  if (v.status !== "success") {
    return { httpStatus: 200, body: { success: true, status: v.status, amount: v.amount, reference, message: `Payment ${v.status}` } }
  }
  const r = await settleStorefrontPayment(d, {
    table, orderId: payment.order_id, walletPaymentId: payment.id, reference, paidAmount: v.amount,
    transactionId: v.transaction_id ?? null,
  })
  if (r.outcome === "amount_mismatch") {
    return { httpStatus: 400, body: { error: "Payment amount mismatch - payment rejected", success: false } }
  }
  if (r.outcome === "refused") return { httpStatus: 400, body: { error: "Invalid order", success: false } }
  if (r.outcome === "error") return { httpStatus: 500, body: { error: "Verification failed" } }
  return { httpStatus: 200, body: { success: true, status: "success", amount: v.amount, reference, message: "Payment verified!" } }
}
