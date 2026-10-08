// lib/ussd-hubtel/callbacks.ts
import type { HubtelTxRow, HubtelTxStore } from "./types"

/** Hubtel requires the callback within 1h of fulfilment; stop retrying at 55 minutes. */
export const CALLBACK_WINDOW_MS = 55 * 60 * 1000

export type CallbackSender = (p: { sessionId: string; orderId: string; serviceStatus: "success" | "failed" }) => Promise<{ ok: boolean; error?: string }>

export function callbackDisposition(
  row: Pick<HubtelTxRow, "callback_status" | "paid_at"> & Partial<Pick<HubtelTxRow, "created_at">>,
  now: number
): "send" | "expire" | "skip" {
  if (row.callback_status !== "pending") return "skip"
  // No paid_at (e.g. a row recovered without one): the session start bounds the window instead,
  // so a pending callback can never retry forever.
  const ref = row.paid_at ?? row.created_at ?? null
  const parsed = ref ? new Date(ref).getTime() : NaN
  const paid = Number.isFinite(parsed) ? parsed : now
  return now - paid > CALLBACK_WINDOW_MS ? "expire" : "send"
}

export async function dispatchCallback(
  store: HubtelTxStore,
  send: CallbackSender,
  sessionId: string,
  now: number = Date.now()
): Promise<"sent" | "retry" | "expired" | "skipped"> {
  const row = await store.findBySession(sessionId)
  if (!row) return "skipped"
  const disposition = callbackDisposition(row, now)
  if (disposition === "skip") return "skipped"
  if (disposition === "expire") {
    await store.update(sessionId, { callback_status: "failed", callback_last_error: row.callback_last_error ?? "callback window expired" })
    return "expired"
  }
  if (!row.hubtel_order_id) {
    await store.update(sessionId, { callback_attempts: row.callback_attempts + 1, callback_last_error: "no Hubtel order id on record" })
    return "retry"
  }
  // Paid and delivered -> success. Paid but NOT delivered (handler failed, underpaid, late
  // success parked for review) -> failed, so Hubtel does not treat an undelivered order as fulfilled.
  const serviceStatus = row.state === "fulfilled" ? "success" : "failed"
  const result = await send({ sessionId, orderId: row.hubtel_order_id, serviceStatus })
  if (result.ok) {
    await store.update(sessionId, {
      callback_status: "sent", callback_attempts: row.callback_attempts + 1,
      callback_sent_at: new Date(now).toISOString(), callback_last_error: null,
    })
    return "sent"
  }
  await store.update(sessionId, { callback_attempts: row.callback_attempts + 1, callback_last_error: result.error ?? "callback failed" })
  return "retry"
}
