// lib/ussd-hubtel/callbacks.ts
import type { HubtelTxRow, HubtelTxStore } from "./types"

/** Hubtel requires the callback within 1h of fulfilment; stop retrying at 55 minutes. */
export const CALLBACK_WINDOW_MS = 55 * 60 * 1000

export type CallbackSender = (p: { sessionId: string; orderId: string }) => Promise<{ ok: boolean; error?: string }>

export function callbackDisposition(
  row: Pick<HubtelTxRow, "callback_status" | "paid_at">,
  now: number
): "send" | "expire" | "skip" {
  if (row.callback_status !== "pending") return "skip"
  const paid = row.paid_at ? new Date(row.paid_at).getTime() : now
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
  const result = await send({ sessionId, orderId: row.hubtel_order_id })
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
