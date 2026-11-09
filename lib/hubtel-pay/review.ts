// lib/hubtel-pay/review.ts
// Admin tooling for Hubtel payments a human must decide: rows in needs_review, and confirming rows whose claim went
// stale (a caller died mid-handler). Route: app/api/admin/gateway/hubtel-payments.
//
//   recheck   asks Hubtel through the relay status check and reports what it says. Writes nothing.
//   fulfil    calls the shared success handler, exactly once even under two concurrent clicks: the row is taken with
//             ONE conditional update (needs_review -> confirming, or the claim RPC for a stale confirming row) and only
//             the taker goes on. Refused unless a fresh status check says Paid, by mobile money/wallet, and Hubtel's own
//             figures show we received at least what we requested (the status-check amount INCLUDES Hubtel's charge,
//             which sits on top for the customer, so amount - charges is what reaches us). Also refused when another
//             attempt for the order is already paid, or anything else shows this is a second payment (the customer paid
//             twice: deliver once, and the admin pays the other back, see markRefundedManually).
//   markFailed closes the Hubtel row only, after a fresh check that does not say Paid. The order is left alone: a
//             missing payment record is not proof of no payment, and the order's own tools decide its fate. The sweep
//             still re-checks a failed row for 72h, so a late payment comes back here.
//   markRefundedManually records that an admin paid a second payment back outside the app. It moves no money. Only a
//             needs_review row, only after a fresh check says Paid, and only when classifySecondPayment says something
//             else paid for the order: never a way out for an order's only payment. Terminal: nothing re-checks, claims or
//             fulfils the row, and the refund fold ignores it, so the first payment becomes refundable again.
//
// Every action is logged with the admin id and the opaque reference only (no phone numbers, nothing the admin typed).
import type { SupabaseClient } from "@supabase/supabase-js"
import type { ChargeEventData } from "@/lib/payments/charge-events"
import { CLOSED_SHOP_ORDER_STATUSES } from "@/lib/payments/closed-order"
import { isStorefrontOrderType } from "@/lib/storefront-commission/payment"
import { checkPaymentStatus, type PaymentStatus } from "./client"
import { isAllowedPaymentMethod, reportsLatePayment, reportsOrderClosed, type HubtelPaymentStatus } from "./confirm"
import { findHubtelAttempts, isManuallyRefundedPayment } from "./lookup"

export const STALE_CONFIRMING_MS = 10 * 60_000
const REF_RE = /^[0-9a-f]{32}$/
/** The admin's words for the way out, in every message that sends them to it. Matches the button. */
const MANUAL_EXIT = 'pay it back by hand, then use "Refunded outside the app"'

export interface ReviewRow {
  reference: string
  internal_reference: string | null
  surface: string
  amount_pesewas: number
  handler_amount_pesewas: number | null
  metadata: unknown
  status: HubtelPaymentStatus
  last_check: unknown
  created_at: string
  claimed_at: string | null
}

/** What the admin list shows. No msisdn, no raw payload. */
export interface ReviewItem {
  reference: string
  internalReference: string | null
  surface: string
  amountGhs: number
  status: HubtelPaymentStatus
  reason: string
  ageMinutes: number
  createdAt: string
}

export interface CheckSummary {
  kind: PaymentStatus["kind"]
  amountGhs: number | null
  chargesGhs: number | null
  paymentMethod: string | null
}

/** What the shop order behind one payment says about who paid for it. */
export interface OrderPaymentFacts {
  orderStatus: string | null
  paymentStatus: string | null
  /** This payment's own wallet_payments row is completed. */
  ownPaymentCompleted: boolean
  /** Another wallet_payments row on the order is completed and its money wasn't already returned by hand. */
  otherPaymentCompleted: boolean
  /** order_refunds has a completed refund for this order. */
  refundCompleted: boolean
}

export interface ReviewStore {
  listOpen(now: Date): Promise<ReviewRow[]>
  load(reference: string): Promise<ReviewRow | null>
  /**
   * Atomically take the row for a fulfil: needs_review -> confirming, or a stale confirming claim through the claim RPC.
   * Returns the claimed_at to guard the final write on, exactly as the database returned it, or null if another caller
   * holds or closed the row. Throws on a database error.
   */
  take(row: ReviewRow): Promise<string | null>
  /** Guarded update; returns whether a row changed. Throws on a database error. */
  update(reference: string, patch: Record<string, unknown>, guard: { status: HubtelPaymentStatus[]; claimedAt?: string }): Promise<boolean>
  hasPaidSibling(internalReference: string, exceptReference: string): Promise<boolean>
  /**
   * The I4 read from charge-events.ts, without calling the handler. Null when this payment is not on a shop order: the
   * handler's guard doesn't apply to those either, and only a paid sibling can show a second payment. Throws on a
   * database error.
   */
  orderPaymentFacts(paymentReference: string, metadata: unknown): Promise<OrderPaymentFacts | null>
}

export interface ReviewDeps {
  store: ReviewStore
  /** Closes a pending Hubtel wallet row after Mark failed or a manual refund, unless another attempt for it may hold money. */
  closeWalletPayment?: (internalReference: string) => Promise<void>
  checkStatus: (reference: string) => Promise<PaymentStatus>
  onChargeSuccess: (data: ChargeEventData) => Promise<Response | null>
  log: (event: string, fields: Record<string, unknown>) => void
  now: () => Date
}

export type ActionResult =
  | { ok: true; message: string; check?: CheckSummary }
  | { ok: false; status: 400 | 404 | 409 | 502; message: string; check?: CheckSummary }

const ghs = (p: number | undefined | null) => (typeof p === "number" ? Math.round(p) / 100 : null)
const money = (p: number | null | undefined) => (typeof p === "number" ? `GHS ${(p / 100).toFixed(2)}` : "unknown")

export function summarizeCheck(s: PaymentStatus): CheckSummary {
  return { kind: s.kind, amountGhs: ghs(s.amountPesewas), chargesGhs: ghs(s.chargesPesewas), paymentMethod: s.paymentMethod ?? null }
}

/** One line on why the row is here, from last_check only (status-check payload, or a start outcome). */
export function reasonOf(row: Pick<ReviewRow, "status" | "last_check" | "amount_pesewas">): string {
  if (row.status === "confirming") return "A confirmation started and never finished (claim is stale)."
  const lc: any = row.last_check && typeof row.last_check === "object" ? row.last_check : null
  const d: any = lc?.data ?? lc?.body?.data ?? null
  const status = typeof lc?.status === "string" ? lc.status : typeof d?.status === "string" ? d.status : null
  if (!lc) return "No status check recorded."
  if (status === "Paid") {
    const amount = typeof d?.amount === "number" ? Math.round(d.amount * 100) : null
    const method = typeof d?.paymentMethod === "string" ? d.paymentMethod.slice(0, 30) : "unknown method"
    if (amount !== null && amount < row.amount_pesewas) return `Hubtel says Paid ${money(amount)}, less than the ${money(row.amount_pesewas)} requested.`
    if (!isAllowedPaymentMethod(d?.paymentMethod)) return `Hubtel says Paid by "${method}", which is not mobile money or wallet.`
    return `Hubtel says Paid ${money(amount)} (${method}). See the alert for why it was not fulfilled.`
  }
  if (lc.upstreamStatus === 404) return "Hubtel has no record of this payment."
  if (status) return `Hubtel status: ${String(status).slice(0, 30)}.`
  return "Last status check was inconclusive."
}

export async function listReview(deps: Pick<ReviewDeps, "store" | "now">): Promise<ReviewItem[]> {
  const now = deps.now()
  const rows = await deps.store.listOpen(now)
  return rows.map((r) => ({
    reference: r.reference,
    internalReference: r.internal_reference,
    surface: r.surface,
    amountGhs: r.amount_pesewas / 100,
    status: r.status,
    reason: reasonOf(r),
    ageMinutes: Math.max(0, Math.floor((now.getTime() - new Date(r.created_at).getTime()) / 60_000)),
    createdAt: r.created_at,
  }))
}

const isStaleConfirming = (r: ReviewRow, now: Date) =>
  r.status === "confirming" && !!r.claimed_at && new Date(r.claimed_at).getTime() < now.getTime() - STALE_CONFIRMING_MS

/** Rows the tooling may act on. Anything else (pending, paid, failed, a fresh claim) belongs to the normal path. */
const actionable = (r: ReviewRow, now: Date) => r.status === "needs_review" || isStaleConfirming(r, now)

async function loadActionable(deps: ReviewDeps, reference: string): Promise<ReviewRow | ActionResult> {
  if (typeof reference !== "string" || !REF_RE.test(reference)) return { ok: false, status: 400, message: "Invalid reference" }
  const row = await deps.store.load(reference)
  if (!row) return { ok: false, status: 404, message: "Payment not found" }
  if (!actionable(row, deps.now())) return { ok: false, status: 409, message: `This payment is ${row.status} and is not waiting for review.` }
  return row
}
const isResult = (x: ReviewRow | ActionResult): x is ActionResult => "ok" in x

export async function recheckPayment(deps: ReviewDeps, reference: string, adminId: string): Promise<ActionResult> {
  const row = await loadActionable(deps, reference)
  if (isResult(row)) return row
  const check = summarizeCheck(await deps.checkStatus(reference))
  deps.log("recheck", { adminId, reference, kind: check.kind })
  return { ok: true, message: `Hubtel says: ${check.kind}.`, check }
}

/** Why a status check does not allow fulfilment, or null when it does. */
export function fulfilRefusal(row: Pick<ReviewRow, "amount_pesewas">, s: PaymentStatus): string | null {
  if (s.kind !== "paid") return `Hubtel does not say Paid (it says ${s.kind}). Not fulfilled.`
  if (!isAllowedPaymentMethod(s.paymentMethod)) return "Paid by a method that is not mobile money or wallet. Not fulfilled."
  const gross = s.amountPesewas
  const charges = s.chargesPesewas
  if (typeof gross !== "number" || !Number.isSafeInteger(gross)) return "Hubtel did not report the amount paid. Not fulfilled."
  if (typeof charges !== "number" || !Number.isSafeInteger(charges) || charges < 0) return "Hubtel did not report its charge, so what reached us is unknown. Not fulfilled."
  if (gross - charges < row.amount_pesewas) {
    return `Hubtel received ${money(gross - charges)} after its charge, less than the ${money(row.amount_pesewas)} requested. Not fulfilled.`
  }
  return null
}

/**
 * second          something other than this payment paid for the order, so this money is extra.
 * not_second      nothing shows another payment: this may be the order's only one.
 * refund_running  a refund is in flight on the order. Decide after it ends.
 * unclear         the order was refunded and nothing shows this money is separate from what was refunded.
 */
export type SecondPaymentVerdict = "second" | "not_second" | "refund_running" | "unclear"

export function classifySecondPayment({ paidSibling, order }: { paidSibling: boolean; order: OrderPaymentFacts | null }): SecondPaymentVerdict {
  if (order?.orderStatus === "refunding") return "refund_running"
  // Two opaque references, both Paid: two separate payments, on any kind of order.
  if (paidSibling) return "second"
  if (!order) return "not_second"
  // charge-events.ts completes the wallet row before it flips the order, so a completed order over an open row was paid by
  // something else (say the buyer's wallet, which has no wallet_payments row).
  const paidElsewhere = order.paymentStatus === "completed" && !order.ownPaymentCompleted
  if (order.orderStatus === "refunded") {
    if (!order.refundCompleted) return "unclear"
    return order.otherPaymentCompleted || paidElsewhere ? "second" : "unclear"
  }
  if (order.paymentStatus === "completed") return order.otherPaymentCompleted || paidElsewhere ? "second" : "not_second"
  // A closed order never records a late payment, so the other late payment is what shows this one is extra.
  return order.otherPaymentCompleted && CLOSED_SHOP_ORDER_STATUSES.includes(String(order.orderStatus)) ? "second" : "not_second"
}

async function readSecondPayment(deps: ReviewDeps, row: ReviewRow): Promise<SecondPaymentVerdict> {
  const paidSibling = !!row.internal_reference && (await deps.store.hasPaidSibling(row.internal_reference, row.reference))
  const order = await deps.store.orderPaymentFacts(row.internal_reference ?? row.reference, row.metadata)
  return classifySecondPayment({ paidSibling, order })
}

const REFUND_RUNNING_MESSAGE = "A refund is running on this order. Wait for it to finish, then try again."
const UNCLEAR_MESSAGE = "The order was refunded, and its records can't show this payment is separate from the one refunded. Check it by hand with Hubtel."

export async function fulfilPayment(deps: ReviewDeps, reference: string, adminId: string): Promise<ActionResult> {
  const row = await loadActionable(deps, reference)
  if (isResult(row)) return row
  const status = await deps.checkStatus(reference)
  const check = summarizeCheck(status)
  const refusal = fulfilRefusal(row, status)
  if (refusal) {
    deps.log("fulfil_refused", { adminId, reference, kind: check.kind })
    return { ok: false, status: 409, message: refusal, check }
  }
  // Refused before the handler, because on a closed order it would answer "late payment" and this row would be recorded
  // paid: /admin/refunds returns one payment per order, so a second one recorded paid would have no way out.
  const verdict = await readSecondPayment(deps, row)
  if (verdict !== "not_second") {
    deps.log("fulfil_refused", { adminId, reference, kind: verdict })
    const message = verdict === "second"
      ? `Another payment for this order is already paid: the customer paid twice. Not fulfilled; ${MANUAL_EXIT}.`
      : `${verdict === "refund_running" ? REFUND_RUNNING_MESSAGE : UNCLEAR_MESSAGE} Not fulfilled.`
    return { ok: false, status: 409, message, check }
  }

  const claimedAt = await deps.store.take(row)
  if (!claimedAt) {
    deps.log("fulfil_lost_race", { adminId, reference })
    return { ok: false, status: 409, message: "Someone else is already handling this payment. Refresh the list.", check }
  }
  const stamp = () => deps.now().toISOString()
  const backToReview = () => deps.store.update(reference, { status: "needs_review", last_check: status.raw, updated_at: stamp() }, { status: ["confirming"], claimedAt })
  deps.log("fulfil_start", { adminId, reference })

  let res: Response | null
  try {
    res = await deps.onChargeSuccess({
      reference: row.internal_reference ?? row.reference,
      metadata: row.metadata ?? undefined,
      // Our amount, never Hubtel's gross: see confirm.ts.
      amount: row.handler_amount_pesewas ?? row.amount_pesewas,
      id: status.transactionId,
      gateway_response: "Hubtel: Paid (admin fulfil)",
    })
  } catch (e) {
    deps.log("fulfil_handler_threw", { adminId, reference, error: e instanceof Error ? e.name : "unknown" })
    await backToReview().catch(() => false)
    return { ok: false, status: 502, message: "The fulfilment handler failed. The payment is back in review; nothing was marked paid.", check }
  }
  const okStatus = res === null || (res.status >= 200 && res.status < 300)
  if (!okStatus) {
    deps.log("fulfil_handler_refused", { adminId, reference, httpStatus: res!.status })
    await backToReview().catch(() => false)
    return { ok: false, status: 502, message: `The fulfilment handler answered ${res!.status}. The payment is back in review.`, check }
  }
  // A fresh check says Paid and the order closed before it landed: nothing to deliver. Record it as paid (the money is
  // held), which is what lets /admin/refunds return it. Otherwise the row has no exit: it can't be fulfilled or failed.
  if (await reportsLatePayment(res)) {
    let recorded = false
    try {
      recorded = await deps.store.update(reference, {
        status: "paid", last_check: status.raw, updated_at: stamp(),
        hubtel_transaction_id: status.transactionId ?? null, charges_pesewas: status.chargesPesewas ?? null, payment_method: status.paymentMethod ?? null,
      }, { status: ["confirming"], claimedAt })
    } catch {
      recorded = false
    }
    deps.log("fulfil_late_payment", { adminId, reference, recorded })
    if (!recorded) {
      await backToReview().catch(() => false)
      return { ok: false, status: 502, message: "The order was already closed, but the payment could not be recorded. It is back in review; try again.", check }
    }
    return { ok: true, message: "The order was already closed, so nothing was delivered. The payment is recorded: refund it on /admin/refunds.", check }
  }
  if (await reportsOrderClosed(res)) {
    deps.log("fulfil_order_closed", { adminId, reference })
    await backToReview().catch(() => false)
    return { ok: false, status: 409, message: `The order was already closed, so nothing was delivered. The payment is back in review. If another payment settled the order, ${MANUAL_EXIT}.`, check }
  }
  let marked = false
  try {
    marked = await deps.store.update(reference, {
      status: "paid", last_check: status.raw, updated_at: stamp(),
      hubtel_transaction_id: status.transactionId ?? null, charges_pesewas: status.chargesPesewas ?? null, payment_method: status.paymentMethod ?? null,
    }, { status: ["confirming"], claimedAt })
  } catch {
    marked = false
  }
  deps.log("fulfil_done", { adminId, reference, marked })
  return marked
    ? { ok: true, message: "Fulfilled and marked paid.", check }
    : { ok: true, message: "Fulfilled, but the payment could not be marked paid; the sweep may re-run the (idempotent) handler.", check }
}

export async function markPaymentFailed(deps: ReviewDeps, reference: string, adminId: string): Promise<ActionResult> {
  const row = await loadActionable(deps, reference)
  if (isResult(row)) return row
  const status = await deps.checkStatus(reference)
  const check = summarizeCheck(status)
  if (status.kind === "paid") {
    deps.log("mark_failed_refused", { adminId, reference, kind: "paid" })
    return { ok: false, status: 409, message: `Hubtel says this payment is Paid: money is held, so it cannot be marked failed. Fulfil it, or if it is a second payment, ${MANUAL_EXIT}.`, check }
  }
  if (status.kind === "error") {
    deps.log("mark_failed_refused", { adminId, reference, kind: "error" })
    return { ok: false, status: 502, message: "The status check failed, so a payment can't be ruled out. Try again.", check }
  }
  const guard = row.status === "confirming"
    ? { status: ["confirming" as const], claimedAt: row.claimed_at ?? undefined }
    : { status: ["needs_review" as const] }
  const wrote = await deps.store.update(reference, { status: "failed", last_check: status.raw, updated_at: deps.now().toISOString() }, guard)
  deps.log("mark_failed", { adminId, reference, kind: check.kind, wrote })
  if (!wrote) return { ok: false, status: 409, message: "The payment changed while you were looking. Refresh the list.", check }
  // The Paystack verifiers skip Hubtel wallet rows, so a pending one left here would never close and could crowd out real
  // rows. A late payment can still complete a failed row. Best effort: the row is already failed.
  try {
    await deps.closeWalletPayment?.(row.internal_reference ?? row.reference)
  } catch (e) {
    deps.log("mark_failed_wallet_row_left_open", { adminId, reference, error: e instanceof Error ? e.message : "unknown error" })
  }
  return { ok: true, message: "Marked failed. The order itself was not changed.", check }
}

const ADMIN_REFERENCE_MIN = 4
const ADMIN_REFERENCE_MAX = 100
const NOTE_MIN = 3
const NOTE_MAX = 500
const ANY_CONTROL_CHAR = /[\u0000-\u001f\u007f]/
/** A note may run over several lines. */
const NOTE_CONTROL_CHAR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** What the admin typed, trimmed, or the reason it can't be stored. The reason never repeats their words. */
function readManualRefundForm(form: { adminReference: unknown; note: unknown }): { adminReference: string; note: string } | string {
  if (typeof form?.adminReference !== "string" || typeof form?.note !== "string") return "Enter the MoMo or Hubtel reference and a note."
  const adminReference = form.adminReference.trim()
  const note = form.note.trim()
  if (adminReference.length < ADMIN_REFERENCE_MIN || adminReference.length > ADMIN_REFERENCE_MAX || ANY_CONTROL_CHAR.test(adminReference)) {
    return `The MoMo or Hubtel reference must be ${ADMIN_REFERENCE_MIN} to ${ADMIN_REFERENCE_MAX} characters on one line.`
  }
  if (note.length < NOTE_MIN || note.length > NOTE_MAX || NOTE_CONTROL_CHAR.test(note)) return `The note must be ${NOTE_MIN} to ${NOTE_MAX} characters.`
  return { adminReference, note }
}

async function loadForManualRefund(deps: ReviewDeps, reference: string): Promise<ReviewRow | ActionResult> {
  if (typeof reference !== "string" || !REF_RE.test(reference)) return { ok: false, status: 400, message: "Invalid reference" }
  const row = await deps.store.load(reference)
  if (!row) return { ok: false, status: 404, message: "Payment not found" }
  // Not a stale confirming row: its handler may have run, and Fulfil is what settles that.
  if (row.status !== "needs_review") return { ok: false, status: 409, message: `This payment is ${row.status} and is not waiting for review.` }
  return row
}

/** Hubtel's fresh answer when this payment qualifies, or the refusal. Writes nothing. */
async function manualRefundGate(deps: ReviewDeps, row: ReviewRow, adminId: string): Promise<{ status: PaymentStatus; check: CheckSummary } | ActionResult> {
  const reference = row.reference
  const status = await deps.checkStatus(reference)
  const check = summarizeCheck(status)
  if (status.kind !== "paid") {
    deps.log("refunded_manually_refused", { adminId, reference, kind: check.kind })
    return status.kind === "error"
      ? { ok: false, status: 502, message: "The status check failed, so this can't be recorded yet. Try again.", check }
      : { ok: false, status: 409, message: `Hubtel does not say Paid (it says ${check.kind}), so there is nothing to have refunded. Not recorded.`, check }
  }

  const verdict = await readSecondPayment(deps, row)
  if (verdict !== "second") {
    deps.log("refunded_manually_refused", { adminId, reference, kind: verdict })
    const message = verdict === "refund_running" ? `${REFUND_RUNNING_MESSAGE} Not recorded.`
      : verdict === "unclear" ? `${UNCLEAR_MESSAGE} Not recorded.`
      : "Nothing else shows as paid for this order, so this may be its only payment. Not recorded; this action is only for a second payment. Use Fulfil."
    return { ok: false, status: 409, message, check }
  }
  return { status, check }
}

/** Asked before the form opens, so an admin doesn't pay a customer back and only then learn the payment doesn't qualify. */
export async function checkManualRefund(deps: ReviewDeps, reference: string, adminId: string): Promise<ActionResult> {
  const row = await loadForManualRefund(deps, reference)
  if (isResult(row)) return row
  const gate = await manualRefundGate(deps, row, adminId)
  if ("ok" in gate) return gate
  return { ok: true, message: "This is a second payment. Pay the customer back, then record it here.", check: gate.check }
}

export async function markRefundedManually(
  deps: ReviewDeps, reference: string, adminId: string, form: { adminReference: unknown; note: unknown },
): Promise<ActionResult> {
  const row = await loadForManualRefund(deps, reference)
  if (isResult(row)) return row
  const typed = readManualRefundForm(form)
  if (typeof typed === "string") return { ok: false, status: 400, message: typed }

  const gate = await manualRefundGate(deps, row, adminId)
  if ("ok" in gate) return gate
  const { status, check } = gate

  const at = deps.now().toISOString()
  // The one write, guarded on status: of two clicks, or a click and a Fulfil, only one gets past here.
  const wrote = await deps.store.update(reference, {
    status: "refunded_manually",
    manual_refund: { admin_reference: typed.adminReference, note: typed.note, admin_id: adminId, recorded_at: at },
    last_check: status.raw, updated_at: at,
    hubtel_transaction_id: status.transactionId ?? null, charges_pesewas: status.chargesPesewas ?? null, payment_method: status.paymentMethod ?? null,
  }, { status: ["needs_review"] })
  deps.log("refunded_manually", { adminId, reference, wrote })
  if (!wrote) return { ok: false, status: 409, message: "The payment changed while you were looking. Refresh the list.", check }
  // This payment's wallet row, if still open. Best effort: the row is already closed.
  try {
    await deps.closeWalletPayment?.(row.internal_reference ?? row.reference)
  } catch (e) {
    deps.log("refunded_manually_wallet_row_left_open", { adminId, reference, error: e instanceof Error ? e.name : "unknown" })
  }
  return { ok: true, message: "Recorded as refunded outside the app. No money moved and the order was not changed.", check }
}

/** wallet_payments.order_type values whose order_id is not a shop order, as in charge-events.ts. */
const NOT_SHOP_ORDER_TYPES = new Set(["dealer_upgrade", "airtime", "results_checker", "results_check_service", "ussd_shop_activation", "ussd_shop_token"])
const NOT_SHOP_METADATA_ORDER_TYPES = new Set(["airtime", "results_checker", "results_check_service"])

export const REVIEW_COLUMNS = "reference, internal_reference, surface, amount_pesewas, handler_amount_pesewas, metadata, status, last_check, created_at, claimed_at"

export function supabaseReviewStore(sb: SupabaseClient): ReviewStore {
  return {
    async listOpen(now) {
      const staleBefore = new Date(now.getTime() - STALE_CONFIRMING_MS).toISOString()
      const [review, stale] = await Promise.all([
        sb.from("hubtel_payments").select(REVIEW_COLUMNS).eq("status", "needs_review").order("created_at", { ascending: true }).limit(200),
        sb.from("hubtel_payments").select(REVIEW_COLUMNS).eq("status", "confirming").lt("claimed_at", staleBefore).order("created_at", { ascending: true }).limit(200),
      ])
      for (const r of [review, stale]) if (r.error) throw new Error(`hubtel_payments review list failed: ${r.error.message}`)
      return [...(review.data ?? []), ...(stale.data ?? [])] as ReviewRow[]
    },
    async load(reference) {
      const { data, error } = await sb.from("hubtel_payments").select(REVIEW_COLUMNS).eq("reference", reference).maybeSingle()
      if (error) throw new Error(`hubtel_payments load failed: ${error.message}`)
      return (data as ReviewRow | null) ?? null
    },
    async take(row) {
      if (row.status === "confirming") {
        const { data, error } = await sb.rpc("claim_hubtel_payment", { p_reference: row.reference })
        if (error) throw new Error(`claim_hubtel_payment failed: ${error.message}`)
        const claimed = (Array.isArray(data) ? data[0] : data) as { claimed_at?: string } | null
        return claimed?.claimed_at ?? null
      }
      const { data, error } = await sb.from("hubtel_payments")
        .update({ status: "confirming", claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("reference", row.reference).eq("status", "needs_review").select("claimed_at")
      if (error) throw new Error(`hubtel_payments take failed: ${error.message}`)
      return ((data ?? [])[0] as { claimed_at?: string } | undefined)?.claimed_at ?? null
    },
    async update(reference, patch, guard) {
      let q = sb.from("hubtel_payments").update(patch).eq("reference", reference).in("status", guard.status)
      if (guard.claimedAt !== undefined) q = q.eq("claimed_at", guard.claimedAt)
      const { data, error } = await q.select("reference")
      if (error) throw new Error(`hubtel_payments update failed: ${error.message}`)
      return (data?.length ?? 0) > 0
    },
    async hasPaidSibling(internalReference, exceptReference) {
      const { data, error } = await sb.from("hubtel_payments").select("reference")
        .eq("internal_reference", internalReference).neq("reference", exceptReference).eq("status", "paid").limit(1)
      if (error) throw new Error(`hubtel_payments paid-sibling check failed: ${error.message}`)
      return (data?.length ?? 0) > 0
    },
    async orderPaymentFacts(paymentReference, metadata) {
      const { data: own, error: ownError } = await sb.from("wallet_payments").select("status, order_id, order_type").eq("reference", paymentReference).maybeSingle()
      if (ownError) throw new Error(`wallet payment read failed: ${ownError.message}`)
      const meta = (metadata && typeof metadata === "object" ? metadata : {}) as { type?: unknown; orderType?: unknown }
      const orderType = own?.order_type as unknown
      if (!own?.order_id || NOT_SHOP_ORDER_TYPES.has(String(orderType)) || isStorefrontOrderType(orderType)) return null
      if (meta.type === "dealer_upgrade" || NOT_SHOP_METADATA_ORDER_TYPES.has(String(meta.orderType))) return null

      const { data: order, error: orderError } = await sb.from("shop_orders").select("order_status, payment_status").eq("id", own.order_id).maybeSingle()
      if (orderError) throw new Error(`shop order read failed: ${orderError.message}`)
      if (!order) return null

      // Read after the order: the handler completes the wallet row first, so a completed order is never paired with an
      // older open row, which would make this payment look like a second one.
      const { data: ownNow, error: ownNowError } = await sb.from("wallet_payments").select("status").eq("reference", paymentReference).maybeSingle()
      if (ownNowError) throw new Error(`wallet payment read failed: ${ownNowError.message}`)

      const { data: others, error: othersError } = await sb.from("wallet_payments").select("reference")
        .eq("order_id", own.order_id).eq("status", "completed").neq("reference", paymentReference).limit(50)
      if (othersError) throw new Error(`wallet payment read failed: ${othersError.message}`)
      const otherRefs = (others ?? []).map((o) => o.reference as string)
      const attempts = await findHubtelAttempts(sb, otherRefs)

      const { data: refunds, error: refundError } = await sb.from("order_refunds").select("id")
        .eq("order_table", "shop_orders").eq("order_id", own.order_id).eq("status", "completed").limit(1)
      if (refundError) throw new Error(`order refund read failed: ${refundError.message}`)

      return {
        orderStatus: (order.order_status as string | null) ?? null,
        paymentStatus: (order.payment_status as string | null) ?? null,
        ownPaymentCompleted: ownNow?.status === "completed",
        otherPaymentCompleted: otherRefs.some((r) => !isManuallyRefundedPayment(attempts.get(r) ?? [])),
        refundCompleted: (refunds?.length ?? 0) > 0,
      }
    },
  }
}

export async function defaultReviewDeps(sb: SupabaseClient): Promise<ReviewDeps> {
  const events = await import("@/lib/payments/charge-events")
  const { closeRefusedHubtelWalletPayment } = await import("@/lib/payment-gateway/close-refused")
  return {
    store: supabaseReviewStore(sb),
    closeWalletPayment: async (internalReference) => { await closeRefusedHubtelWalletPayment(sb, internalReference) },
    checkStatus: (ref) => checkPaymentStatus(ref),
    onChargeSuccess: events.handleChargeSuccess,
    log: (event, fields) => console.warn(`[ADMIN-HUBTEL-REVIEW] ${event}`, JSON.stringify(fields)),
    now: () => new Date(),
  }
}
