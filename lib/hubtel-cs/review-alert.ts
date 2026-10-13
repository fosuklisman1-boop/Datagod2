import type { HubtelCsTx } from "./types"

/** At most one "needs review" alert per 15 minutes, however many rows enter the queue. */
export const REVIEW_ALERT_DEBOUNCE_MS = 15 * 60_000

export function reviewAlertText(tx: HubtelCsTx): { subject: string; message: string } {
  return {
    subject: "Hubtel transaction needs review",
    message: `${tx.client_reference} (${tx.service_key}, GHS ${Number(tx.amount).toFixed(2)}${tx.destination ? `, to ${tx.destination}` : ""}` +
      `${tx.order_table && tx.order_id ? `, order ${tx.order_table}/${tx.order_id}` : ""}) needs review: ` +
      `${tx.review_reason ?? "no reason recorded"}. Open /admin/hubtel-commission → Review Queue. Do not resend; check status first.`,
  }
}
