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
    try {
      await args.store.update(row.session_id, { state: "needs_review", callback_status: "pending" })
      out.swept++
    } catch (e) { console.error("[HUBTEL-STATUS] sweep error:", row.session_id, e) }
  }

  const rows = await args.store.listAwaitingPayment(args.limit ?? 50)

  // Shared Paid handling for the normal check path and the final pre-expiry check.
  // Returns true when the row was resolved as paid (fulfilled or held for review).
  const handlePaid = async (row: HubtelTxRow, res: Awaited<ReturnType<StatusChecker>>): Promise<boolean> => {
    if (!res.ok || res.status !== "Paid") return false
    const d = res.data ?? {}
    const outcome = await processFulfillment(args.store, args.handlers, {
      sessionId: row.session_id,
      hubtelOrderId: typeof d.transactionId === "string" ? d.transactionId : null,
      amountPaid: Number(d.amount ?? 0),
      amountAfterCharges: Number(d.amountAfterCharges ?? 0),
      isSuccessful: true,
    })
    if (outcome === "duplicate") {
      const cur = await args.store.findBySession(row.session_id).catch(() => null)
      console.warn("[HUBTEL-STATUS] Paid but duplicate (row already claimed):", row.session_id, "state:", cur?.state)
    }
    return outcome === "fulfilled" || outcome === "needs_review"
  }

  for (const row of rows) {
    try {
      const disposition = statusCheckDisposition(row, now)
      if (disposition === "skip") continue

      if (disposition === "expire") {
        // One last look: the customer may have paid and the webhook never arrived.
        let finalRes: Awaited<ReturnType<StatusChecker>> | null = null
        try { finalRes = await args.check(row.session_id) } catch (e) {
          console.error("[HUBTEL-STATUS] final check error:", row.session_id, e)
        }
        if (finalRes && (await handlePaid(row, finalRes))) { out.paid++; continue }

        // Race-safe: only expire if we win the claim; otherwise a webhook owns the row.
        if (!(await args.store.claim(row.session_id))) continue
        try {
          // Never paid ⇒ no fulfilment, so no callback is due.
          await args.store.update(row.session_id, { state: "failed", callback_status: "not_due" })
        } catch (e) {
          console.error("[HUBTEL-STATUS] expiry update failed, reverting:", row.session_id, e)
          try { await args.store.update(row.session_id, { state: "awaiting_payment" }) } catch (e2) {
            console.error("[HUBTEL-STATUS] expiry revert failed:", row.session_id, e2)
          }
          continue
        }
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
      if (await handlePaid(row, res)) out.paid++
    } catch (e) { console.error("[HUBTEL-STATUS] row error:", row.session_id, e) }
  }
  return out
}
