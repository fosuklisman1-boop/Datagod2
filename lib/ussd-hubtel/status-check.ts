// lib/ussd-hubtel/status-check.ts
import { processFulfillment, type OrderHandlers } from "./payment"
import type { HubtelTxRow, HubtelTxStore } from "./types"

export const STATUS_CHECK_MIN_AGE_MS = 5 * 60_000
export const STATUS_CHECK_MAX_AGE_MS = 60 * 60_000
export const STATUS_CHECK_MAX_ATTEMPTS = 6
export const STATUS_CHECK_GAP_MS = 5 * 60_000
const STALE_PROCESSING_MINUTES = 10

export type StatusChecker = (sessionId: string) => Promise<{ ok: boolean; status?: string; data?: any; error?: string }>

export function statusCheckDisposition(
  row: Pick<HubtelTxRow, "created_at" | "status_check_attempts" | "last_status_check_at">,
  now: number
): "skip" | "check" | "expire" {
  const age = now - new Date(row.created_at).getTime()
  if (age > STATUS_CHECK_MAX_AGE_MS || row.status_check_attempts >= STATUS_CHECK_MAX_ATTEMPTS) return "expire"
  if (age < STATUS_CHECK_MIN_AGE_MS) return "skip"
  if (row.last_status_check_at && now - new Date(row.last_status_check_at).getTime() < STATUS_CHECK_GAP_MS) return "skip"
  return "check"
}

export async function runStatusChecks(args: {
  store: HubtelTxStore
  handlers: OrderHandlers
  failHandlers: OrderHandlers
  check: StatusChecker
  now?: number
  limit?: number
}): Promise<{ checked: number; paid: number; expired: number; swept: number }> {
  const now = args.now ?? Date.now()
  const out = { checked: 0, paid: 0, expired: 0, swept: 0 }

  // Sweep: a crash between claim and the final update would leave a paid order
  // invisible in 'processing'. Surface it for review; the callback is still due.
  const stale = await args.store.listStaleProcessing(STALE_PROCESSING_MINUTES, args.limit ?? 50)
  for (const row of stale) {
    await args.store.update(row.session_id, { state: "needs_review", callback_status: "pending" })
    out.swept++
  }

  const rows = await args.store.listAwaitingPayment(args.limit ?? 50)

  for (const row of rows) {
    const disposition = statusCheckDisposition(row, now)
    if (disposition === "skip") continue

    if (disposition === "expire") {
      // Race-safe: only expire if we win the claim; otherwise a webhook owns the row.
      if (!(await args.store.claim(row.session_id))) continue
      // Never paid ⇒ no fulfilment, so no callback is due.
      await args.store.update(row.session_id, { state: "failed", callback_status: "not_due" })
      try {
        const fail = args.failHandlers[row.order_table]
        if (fail) await fail(row.order_id)
      } catch (e) { console.error("[HUBTEL-STATUS] fail handler error:", row.session_id, e) }
      out.expired++
      continue
    }

    out.checked++
    const res = await args.check(row.session_id)
    await args.store.update(row.session_id, {
      status_check_attempts: row.status_check_attempts + 1,
      last_status_check_at: new Date(now).toISOString(),
    })
    if (!res.ok || res.status !== "Paid") continue

    const d = res.data ?? {}
    const outcome = await processFulfillment(args.store, args.handlers, {
      sessionId: row.session_id,
      hubtelOrderId: typeof d.transactionId === "string" ? d.transactionId : null,
      amountPaid: Number(d.amount ?? 0),
      amountAfterCharges: Number(d.amountAfterCharges ?? 0),
      isSuccessful: true,
    })
    if (outcome === "fulfilled" || outcome === "needs_review") out.paid++
  }
  return out
}
