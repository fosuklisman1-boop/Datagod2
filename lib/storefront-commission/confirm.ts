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
  hubtel_client_reference: string | null
  notes: string | null
  biller?: string | null
  /** Bills only: when the account was verified (Ghana Water session age). */
  verified_at?: string | null
  created_at: string
}

/** Rows changed, or rows changed + the flipped row's status (preferred; see ConfirmDeps.markPaid). */
export type MarkPaidResult = number | { changed: number; status: string | null }

export interface ConfirmDeps {
  /** Throws on a read error. */
  getOrder(table: StorefrontOrderTable, id: string): Promise<StorefrontPaidOrder | null>
  /**
   * Guarded `unpaid -> paid` (`.eq('payment_status','unpaid')`, commission rows only: channel storefront or bots).
   * Returns the rows changed and, preferably, the `status` the flipped row has (read from the update itself): share
   * and dispatch are decided from it, never from the earlier read. A plain number (status unknown) falls back to the
   * earlier read. Throws on error.
   */
  markPaid(table: StorefrontOrderTable, id: string, patch: { paid_at: string; payment_reference: string }): Promise<MarkPaidResult>
  /** shop_profits insert; throws the PostgREST error (with `code`) on failure. */
  insertShopProfit(row: Record<string, unknown>): Promise<void>
  /** Utility Bills auto-fulfil switch (dashboard rule reused for storefront bills). Throws on a read error. */
  billsAutoFulfil(): Promise<boolean>
  /** Re-read the order through the engine and run its dispatch (atomic pending -> processing claim; one Hubtel POST). */
  dispatch(table: StorefrontOrderTable, id: string): Promise<string>
  /** Note on an order that is still pending AND has no note yet; returns rows changed (0 = someone else wrote one). */
  setPendingNote(table: StorefrontOrderTable, id: string, notes: string): Promise<number>
  /** Is there any Hubtel ledger row (hubtel_cs_transactions) for this order? Throws on a read error. */
  hasLedgerRow(table: StorefrontOrderTable, id: string): Promise<boolean>
  /** `urgent` alerts keep the email fallback when SMS cannot be sent. */
  alert(message: string, urgent?: boolean): Promise<void>
  now(): number
}

export type ConfirmOutcome =
  | "confirmed"          // this call flipped unpaid -> paid
  | "resumed"            // the order was already paid by THIS payment but never sent: share + dispatch re-run
  | "already_processed"  // someone else flipped it (or a replay)
  | "amount_mismatch"    // Paystack amount != paid_amount; left unpaid
  | "refused"            // not a commission order of an accepted channel (or not found)
  | "error"              // could not read / flip; safe to retry

export interface ConfirmResult { outcome: ConfirmOutcome; status?: string }

/** Outcomes after which the order is paid by this payment (payment records may be completed). */
export const isPaidOutcome = (o: ConfirmOutcome): boolean => o === "confirmed" || o === "resumed" || o === "already_processed"

export const MANUAL_DISPATCH_NOTE = "Awaiting manual dispatch"
export const GHANA_WATER_EXPIRED_NOTE = "Not sent: Ghana Water verification expired before payment — refund instead"

/** Channels whose bill / bundle rows this confirmation serves: storefront (web shops) and bots (USSD / WhatsApp). */
export const COMMISSION_CHANNELS = ["storefront", "bots"] as const
export type CommissionChannel = (typeof COMMISSION_CHANNELS)[number]

const pesewas = (n: number) => Math.round(n * 100)
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const safeAlert = async (d: ConfirmDeps, m: string, urgent = false) => { try { await d.alert(m, urgent) } catch { /* never break the flow */ } }

/** Alert wording: storefront rows keep their exact historical text; bot rows say "bot" and name no payment rail. */
const isBot = (o: StorefrontPaidOrder) => o.channel === "bots"
const kind = (o: StorefrontPaidOrder) => (isBot(o) ? "bot" : "storefront")
const Kind = (o: StorefrontPaidOrder) => (isBot(o) ? "Bot" : "Storefront")
const rail = (o: StorefrontPaidOrder) => (isBot(o) ? "" : "Paystack ")

export interface ConfirmPayment {
  /** GHS (Paystack amount / 100). */
  paidAmount: number
  reference: string
  /**
   * Send the payment-level alerts (amount mismatch, duplicate payment). Default true. The public
   * /api/payments/verify path passes false so repeated calls cannot spam admins; the webhook alerts.
   */
  alertPaymentIssues?: boolean
}

/** A second, different Paystack payment for an order that is already paid: money to give back. */
async function alertIfDuplicatePayment(d: ConfirmDeps, order: StorefrontPaidOrder, p: ConfirmPayment) {
  if (p.alertPaymentIssues !== false && order.payment_reference && order.payment_reference !== p.reference) {
    await safeAlert(d, `URGENT: ${kind(order)} order ${order.reference_code} (${order.id}) received a second ${rail(order)}payment ` +
      `(ref ${p.reference}, GHS ${p.paidAmount.toFixed(2)}) after it was already paid with ref ${order.payment_reference}. ` +
      `${isBot(order) ? "Refund the duplicate." : "Refund the duplicate in Paystack."}`, true)
  }
}

/**
 * Confirms a payment for a commission Utility Bill / Standard Bundle order of the storefront (Paystack) or the bots
 * (Paystack or Hubtel checkout) channel. Shared by the Paystack webhook, /api/payments/verify and the bot payment
 * callbacks; safe to call concurrently and to replay.
 *
 * 1. Re-read the order; its channel must be one of `channels` (default: storefront and bots).
 * 2. Pesewa-exact amount check against `paid_amount`; a mismatch leaves the order unpaid (admins alerted).
 * 3. Guarded `unpaid -> paid` (+ paid_at, payment_reference).
 * 4. Post-flip steps: credit the shop share (only with a shop and a share > 0; one row per order, 23505 ignored), then
 *    dispatch through the engine's claim. Errors never un-flip the order. An order that was no longer pending when
 *    paid (failed / expired) gets neither: it is alerted for a refund.
 * 5. Recovery: when the order is already paid by THIS payment, still pending, never noted and has no Hubtel ledger row
 *    (the flipper died or its flip looked failed), the post-flip steps run again. The share's unique index and the
 *    engine's claim keep that to one share and one Hubtel POST even under concurrent retries.
 */
export async function confirmCommissionOrder(
  d: ConfirmDeps,
  table: StorefrontOrderTable,
  orderId: string,
  p: ConfirmPayment,
  channels: readonly CommissionChannel[] = COMMISSION_CHANNELS,
): Promise<ConfirmResult> {
  let order: StorefrontPaidOrder | null
  try {
    order = await d.getOrder(table, orderId)
  } catch (e) {
    console.error(`[storefront-confirm] could not read ${table} ${orderId}:`, msg(e))
    return { outcome: "error" }
  }
  if (!order || !(channels as readonly string[]).includes(order.channel)) {
    console.warn(`[storefront-confirm] refused ${table} ${orderId}: not a ${channels.join("/")} order`)
    return { outcome: "refused" }
  }
  const ref = order.reference_code

  // A replay of the same payment, a second payment, or a stranded paid order.
  if (order.payment_status !== "unpaid") return afterAlreadyPaid(d, table, order, p)

  const expected = Number(order.paid_amount)
  if (order.paid_amount === null || !Number.isFinite(expected) || !Number.isFinite(p.paidAmount) || pesewas(p.paidAmount) !== pesewas(expected)) {
    if (p.alertPaymentIssues !== false) {
      await safeAlert(d, `URGENT: ${kind(order)} order ${ref} (${order.id}): ${isBot(order) ? "Payment" : "Paystack"} amount GHS ${Number(p.paidAmount).toFixed(2)} ` +
        `does not match the order's GHS ${Number.isFinite(expected) ? expected.toFixed(2) : String(order.paid_amount)} (ref ${p.reference}). ` +
        `Not marked paid and not sent; ${isBot(order) ? "review and refund it." : "review and refund in Paystack."}`, true)
    }
    return { outcome: "amount_mismatch", status: order.status }
  }

  let flipped: number
  // The status the row has AT the flip. The earlier read can be stale: the stale-unpaid sweep may fail the order
  // between that read and this (status-unguarded) flip; deciding from the read would credit a share for, and try to
  // send, a failed order. With the flip's own status it takes the needs-review path below instead.
  let statusAtFlip = order.status
  try {
    const m = await d.markPaid(table, order.id, { paid_at: new Date(d.now()).toISOString(), payment_reference: p.reference })
    if (typeof m === "number") {
      flipped = m
    } else {
      flipped = m.changed
      if (m.status) statusAtFlip = m.status
    }
  } catch (e) {
    // The write may still have committed: a retry goes through the recovery path.
    console.error(`[storefront-confirm] paid flip failed for ${ref}:`, msg(e))
    return { outcome: "error" }
  }
  if (flipped === 0) {
    let cur: StorefrontPaidOrder | null = null
    try { cur = await d.getOrder(table, order.id) } catch { cur = null }
    if (!cur) return { outcome: "already_processed", status: order.status }
    return afterAlreadyPaid(d, table, cur, p)
  }

  // This call flipped the order. A non-pending order (failed / expired, then paid) is never sent and is to be
  // refunded, so no shop share is credited for it.
  if (statusAtFlip !== "pending") {
    await safeAlert(d, `URGENT: ${kind(order)} order ${ref} was paid (ref ${p.reference}) while its status is ${statusAtFlip}. Not sent; refund it.`, true)
    return { outcome: "confirmed", status: statusAtFlip }
  }
  return { outcome: "confirmed", status: await postFlip(d, table, order) }
}

/** Historical name (storefront launch); same function: accepts storefront and bot rows. */
export const confirmStorefrontOrder = confirmCommissionOrder

/**
 * Rail-agnostic confirmation for a BOT order only (Hubtel USSD checkout callback, bot Paystack payments): refuses
 * storefront and every other channel. `paidAmount` in GHS; `alertPaymentIssues` false on public / pollable paths.
 */
export function confirmBotOrder(d: ConfirmDeps, table: StorefrontOrderTable, orderId: string, p: ConfirmPayment): Promise<ConfirmResult> {
  return confirmCommissionOrder(d, table, orderId, p, ["bots"])
}

/** The order is not unpaid any more: decide between replay, duplicate payment and recovery. */
async function afterAlreadyPaid(d: ConfirmDeps, table: StorefrontOrderTable, cur: StorefrontPaidOrder, p: ConfirmPayment): Promise<ConfirmResult> {
  if (cur.payment_status !== "paid" || cur.payment_reference !== p.reference) {
    await alertIfDuplicatePayment(d, cur, p)
    return { outcome: "already_processed", status: cur.status }
  }
  // Paid by this payment. Never attempted? (no note: the claim writes "Dispatching…", a pre-POST failure "Not sent…",
  // the Ghana Water / manual paths their own note; no Hubtel reference; no ledger row)
  if (cur.status !== "pending" || cur.notes || cur.hubtel_client_reference) return { outcome: "already_processed", status: cur.status }
  let ledger: boolean
  try {
    ledger = await d.hasLedgerRow(table, cur.id)
  } catch (e) {
    await safeAlert(d, `${Kind(cur)} order ${cur.reference_code} is paid and may never have been sent, but the Hubtel ledger could not be checked (${msg(e)}). Check it by hand; do not resend blindly.`, true)
    return { outcome: "already_processed", status: cur.status }
  }
  if (ledger) return { outcome: "already_processed", status: cur.status }
  console.warn(`[storefront-confirm] resuming paid, never-sent order ${cur.reference_code}`)
  return { outcome: "resumed", status: await postFlip(d, table, cur) }
}

async function creditShare(d: ConfirmDeps, table: StorefrontOrderTable, order: StorefrontPaidOrder): Promise<void> {
  const share = Number(order.shop_share_amount)
  if (!order.shop_id || !Number.isFinite(share) || share <= 0) return
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
      await safeAlert(d, `${Kind(order)} order ${order.reference_code}: paid, but the shop share (GHS ${share.toFixed(2)}) could not be recorded: ${msg(e)}. Credit it by hand.`, true)
    }
  }
}

/** Share, then (bills: Ghana Water age + auto-fulfil checks) dispatch. Idempotent; returns the order status. */
async function postFlip(d: ConfirmDeps, table: StorefrontOrderTable, order: StorefrontPaidOrder): Promise<string | undefined> {
  const ref = order.reference_code
  await creditShare(d, table, order)

  if (table === "hubtel_bill_orders") {
    const verifiedAt = Date.parse(order.verified_at || order.created_at)
    if (order.biller === "ghana_water" && !(d.now() - verifiedAt <= GHANA_WATER_MAX_AGE_MS)) {
      const n = await d.setPendingNote(table, order.id, GHANA_WATER_EXPIRED_NOTE).catch(() => 0)
      if (n > 0) await safeAlert(d, `${Kind(order)} bill order ${ref} was paid after its Ghana Water verification expired. Not sent; refund it.`, true)
      return "pending"
    }
    let auto: boolean
    try { auto = await d.billsAutoFulfil() } catch { auto = false }
    if (!auto) {
      const n = await d.setPendingNote(table, order.id, MANUAL_DISPATCH_NOTE).catch(() => 0)
      if (n > 0) await safeAlert(d, `${Kind(order)} bill order ${ref} is paid and waiting for manual dispatch in Utility Bills.`)
      return "pending"
    }
  }

  try {
    return await d.dispatch(table, order.id)
  } catch (e) {
    await safeAlert(d, `${Kind(order)} order ${ref} is paid but dispatch failed: ${msg(e)}. Check its status before sending.`, true)
    return undefined
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
  /** See ConfirmPayment.alertPaymentIssues: true from the webhook, false from the public verify route. */
  alertPaymentIssues?: boolean
}

/** Confirm the order, then mark the payment records completed when the order is (or already was) paid. */
export async function settleStorefrontPayment(d: SettleDeps, s: SettleInput): Promise<ConfirmResult> {
  const alerts = s.alertPaymentIssues !== false
  if (!s.orderId) {
    if (alerts) await safeAlert(d, `URGENT: storefront payment ${s.reference} (GHS ${s.paidAmount.toFixed(2)}) has no order attached. Review and refund in Paystack.`, true)
    return { outcome: "refused" }
  }
  const r = await confirmCommissionOrder(d, s.table, s.orderId,{ paidAmount: s.paidAmount, reference: s.reference, alertPaymentIssues: alerts })
  if (r.outcome === "refused" && alerts) {
    await safeAlert(d, `URGENT: payment ${s.reference} (GHS ${s.paidAmount.toFixed(2)}) is for ${s.table} ${s.orderId}, which is not a storefront order. Not processed; review and refund in Paystack.`, true)
  }
  if (isPaidOutcome(r.outcome)) {
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
 * Paystack cannot be reached (the route maps it to 500, as today). Never sends payment-level alerts (public endpoint;
 * the webhook alerts once per delivery).
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
    transactionId: v.transaction_id ?? null, alertPaymentIssues: false,
  })
  if (r.outcome === "amount_mismatch") {
    return { httpStatus: 400, body: { error: "Payment amount mismatch - payment rejected", success: false } }
  }
  if (r.outcome === "refused") return { httpStatus: 400, body: { error: "Invalid order", success: false } }
  if (r.outcome === "error") return { httpStatus: 500, body: { error: "Verification failed" } }
  return { httpStatus: 200, body: { success: true, status: "success", amount: v.amount, reference, message: "Payment verified!" } }
}
