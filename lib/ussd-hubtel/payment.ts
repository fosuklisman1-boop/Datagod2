// lib/ussd-hubtel/payment.ts
import type { HubtelFulfillmentInfo, HubtelTxStore } from "./types"
import { safeDbError } from "./log-safe"

export type OrderHandlers = Record<string, (orderId: string) => Promise<void>>
export type FulfillmentOutcome = "unknown_session" | "duplicate" | "unsuccessful" | "needs_review" | "fulfilled"

export function parseFulfillmentPayload(body: unknown): HubtelFulfillmentInfo | null {
  if (!body || typeof body !== "object") return null
  const b = body as any
  if (typeof b.SessionId !== "string" || !b.SessionId) return null
  const payment = b.OrderInfo?.Payment
  if (!payment || typeof payment !== "object") return null
  const paid = Number(payment.AmountPaid)
  const after = Number(payment.AmountAfterCharges)
  if (!Number.isFinite(paid) || !Number.isFinite(after)) return null
  return {
    sessionId: b.SessionId,
    hubtelOrderId: typeof b.OrderId === "string" ? b.OrderId : null,
    amountPaid: paid,
    amountAfterCharges: after,
    isSuccessful: payment.IsSuccessful === true,
  }
}

/** Under-payment (beyond one pesewa) is held; over-payment is fulfilled. */
export function decidePayment(expected: number, info: HubtelFulfillmentInfo): "fulfil" | "needs_review" | "unsuccessful" {
  if (!info.isSuccessful) return "unsuccessful"
  if (!Number.isFinite(info.amountAfterCharges)) return "needs_review" // fail closed on NaN/Infinity
  if (info.amountAfterCharges < expected - 0.01) return "needs_review"
  return "fulfil"
}

/**
 * Best-effort write of the durable needs_review reason (hubtel_transactions.review_reason, migration
 * 0108). Always a SEPARATE update made AFTER the state change, and never throws: code deployed before
 * 0108 is applied still lands the row in needs_review (this update then fails and is logged once).
 * `reason` must already be short and sanitised (ids and fixed text only, never row data).
 */
export async function recordReviewReason(store: HubtelTxStore, sid: string, reason: string): Promise<void> {
  try {
    await store.update(sid, { review_reason: reason })
  } catch (e) {
    console.error("[HUBTEL-PAYMENT] could not store review_reason (is migration 0108 applied?):", sid, safeDbError(e))
  }
}

export async function processFulfillment(
  store: HubtelTxStore,
  handlers: OrderHandlers,
  info: HubtelFulfillmentInfo
): Promise<FulfillmentOutcome> {
  const sid = info.sessionId
  let tx = await store.findBySession(sid)
  if (!tx) return "unknown_session"
  const base = {
    hubtel_order_id: info.hubtelOrderId,
    amount_paid: info.amountPaid,
    amount_after_charges: info.amountAfterCharges,
    paid_at: new Date().toISOString(),
  }
  const needsReview = async (reason?: string) => {
    // Callback is still due: always-success policy (spec §8); the order is resolved manually.
    await store.update(sid, { ...base, state: "needs_review", callback_status: "pending" })
    if (reason) await recordReviewReason(store, sid, reason)
    return "needs_review" as const
  }

  // Atomic awaiting_payment → processing. Only the winner proceeds (idempotency).
  if (!(await store.claim(sid))) {
    // The first snapshot may be stale (expiry or an unsuccessful delivery may have moved the
    // row since): decide on a fresh read, never on `tx`.
    const fresh = await store.findBySession(sid)
    if (fresh?.state === "awaiting_payment" && (await store.claim(sid))) {
      // An unsuccessful delivery held the claim and has just released it: process normally.
      tx = fresh
    } else {
      // An indeterminate-expiry row that an admin resolved 'fulfilled' (delivered manually, no
      // Hubtel OrderId known then) is fulfilled + paid_at null + callback not_due + resolved_at.
      // Hubtel's late success must still be recorded and called back: keep the state, record the
      // OrderId/amounts/paid_at, make the callback due; the order handler is NOT run (the goods were
      // already delivered by hand). The guarded update is the compare-and-set: one winner only.
      if (info.isSuccessful && fresh?.state === "fulfilled" && fresh.paid_at == null &&
          fresh.callback_status === "not_due" && fresh.resolved_at != null) {
        const won = await store.updateIf(
          sid,
          { state: "fulfilled", callback_status: "not_due", paid_atIsNull: true },
          { ...base, callback_status: "pending" },
        )
        if (won) {
          console.warn("[HUBTEL-PAYMENT] late payment recorded on an admin-resolved fulfilled row; callback due:", sid)
          return "fulfilled"
        }
        return "duplicate"
      }
      // Paid after the status-check window expired the row (customer was told it failed), or
      // after expiry parked it because the status check was indeterminate (needs_review with no
      // callback due): record the payment and hold for a human, callback now due; never
      // auto-fulfil. Keyed on paid_at: a declined attempt may record amounts but never paid_at.
      const lateRecoverable = info.isSuccessful && fresh != null && fresh.paid_at == null &&
        (fresh.state === "failed" || (fresh.state === "needs_review" && fresh.callback_status === "not_due"))
      // The needs_review recovery ends in needs_review again (A→B→A), so a state-only claim could
      // be re-won by a recoverer holding a stale read: guard on the still-parked shape as well.
      const guard = fresh?.state === "needs_review" ? { callback_status: "not_due" as const, paid_atIsNull: true } : undefined
      if (lateRecoverable && (await store.claim(sid, [fresh.state], guard))) {
        return needsReview(fresh.state === "failed" ? "late success after expiry" : "late success after indeterminate park")
      }
      if (info.isSuccessful && (fresh?.state === "processing" || fresh?.state === "failed")) {
        // Not a normal already-processed row: this money may not be recorded anywhere else.
        console.error("[HUBTEL-PAYMENT] successful payment not recorded (duplicate on a non-final row):", JSON.stringify({
          session_id: sid, state: fresh.state, paid_at: fresh.paid_at, hubtel_order_id: info.hubtelOrderId,
          amount_paid: info.amountPaid, amount_after_charges: info.amountAfterCharges,
        }))
      }
      return "duplicate"
    }
  }

  const decision = decidePayment(Number(tx.expected_amount), info)

  if (decision === "unsuccessful") {
    // Release the claim, record nothing: the status-check/expiry path owns the row from here,
    // and a later successful delivery for this session is processed normally.
    await store.update(sid, { state: "awaiting_payment", callback_status: "not_due" })
    return "unsuccessful"
  }

  // Persist the payment BEFORE running the handler, so a crash/timeout mid-handler still leaves
  // the Hubtel OrderId and paid_at on the row (callback possible, window bounded).
  await store.update(sid, base)

  if (decision === "needs_review") {
    return needsReview(`underpaid: after_charges ${info.amountAfterCharges} < expected ${Number(tx.expected_amount)}`)
  }
  const handler = handlers[tx.order_table]
  if (!handler) {
    console.error("[HUBTEL-PAYMENT] No handler for order table:", tx.order_table, "session:", sid)
    return needsReview(`no handler for order table ${tx.order_table}`)
  }
  try {
    await handler(tx.order_id)
  } catch (e) {
    const safe = safeDbError(e) // trimmed to SAFE_DB_ERROR_MAX, row details redacted
    console.error("[HUBTEL-PAYMENT] Order handler failed:", sid, safe)
    return needsReview(safe.message)
  }
  await store.update(sid, { ...base, state: "fulfilled", callback_status: "pending" })
  return "fulfilled"
}
