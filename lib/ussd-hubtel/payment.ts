// lib/ussd-hubtel/payment.ts
import type { HubtelFulfillmentInfo, HubtelTxStore } from "./types"

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
  if (info.amountAfterCharges < expected - 0.01) return "needs_review"
  return "fulfil"
}

export async function processFulfillment(
  store: HubtelTxStore,
  handlers: OrderHandlers,
  info: HubtelFulfillmentInfo
): Promise<FulfillmentOutcome> {
  const tx = await store.findBySession(info.sessionId)
  if (!tx) return "unknown_session"
  // Atomic awaiting_payment → processing. Only the winner proceeds (idempotency).
  const base = {
    hubtel_order_id: info.hubtelOrderId,
    amount_paid: info.amountPaid,
    amount_after_charges: info.amountAfterCharges,
    paid_at: new Date().toISOString(),
  }
  const needsReview = async () => {
    // Callback is still due: always-success policy (spec §8); the order is resolved manually.
    await store.update(info.sessionId, { ...base, state: "needs_review", callback_status: "pending" })
    return "needs_review" as const
  }

  if (!(await store.claim(info.sessionId))) {
    // Paid after the status-check window expired the row (customer was told it failed):
    // record the payment and hold for a human; never auto-fulfil.
    if (tx.state === "failed" && tx.amount_paid == null && info.isSuccessful &&
        (await store.claim(info.sessionId, ["failed"]))) {
      return needsReview()
    }
    return "duplicate"
  }

  const decision = decidePayment(Number(tx.expected_amount), info)

  if (decision === "unsuccessful") {
    const { paid_at: _omit, ...failedBase } = base
    await store.update(info.sessionId, { ...failedBase, state: "failed" })
    return "unsuccessful"
  }

  if (decision === "needs_review") return needsReview()
  const handler = handlers[tx.order_table]
  if (!handler) {
    console.error("[HUBTEL-PAYMENT] No handler for order table:", tx.order_table, "session:", info.sessionId)
    return needsReview()
  }
  try {
    await handler(tx.order_id)
  } catch (e) {
    console.error("[HUBTEL-PAYMENT] Order handler failed:", info.sessionId, e)
    return needsReview()
  }
  await store.update(info.sessionId, { ...base, state: "fulfilled", callback_status: "pending" })
  return "fulfilled"
}
