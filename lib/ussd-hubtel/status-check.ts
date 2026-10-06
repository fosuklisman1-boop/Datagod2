// lib/ussd-hubtel/status-check.ts
import { processFulfillment, type OrderHandlers } from "./payment"
import type { HubtelTxRow, HubtelTxStore } from "./types"

export const STATUS_CHECK_MIN_AGE_MS = 5 * 60_000
export const STATUS_CHECK_MAX_AGE_MS = 60 * 60_000
export const STATUS_CHECK_MAX_ATTEMPTS = 6
export const STATUS_CHECK_GAP_MS = 5 * 60_000
const STALE_PROCESSING_MINUTES = 10

export type StatusChecker = (sessionId: string) => Promise<{ ok: boolean; status?: string; data?: any; error?: string }>
type CheckResult = Awaited<ReturnType<StatusChecker>>

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

export const INDETERMINATE_RECHECK_MAX_AGE_MS = 24 * 60 * 60_000
export const INDETERMINATE_RECHECK_MAX_ATTEMPTS = 12

/** Re-check a parked (indeterminate-expiry) row only within 24h, under 12 attempts, and not within the gap. */
export function indeterminateRecheckDisposition(
  row: Pick<HubtelTxRow, "created_at" | "status_check_attempts" | "last_status_check_at">,
  now: number
): "skip" | "check" {
  if (now - new Date(row.created_at).getTime() > INDETERMINATE_RECHECK_MAX_AGE_MS) return "skip"
  if (row.status_check_attempts >= INDETERMINATE_RECHECK_MAX_ATTEMPTS) return "skip"
  if (row.last_status_check_at && now - new Date(row.last_status_check_at).getTime() < STATUS_CHECK_GAP_MS) return "skip"
  return "check"
}

/** A definite answer is Hubtel itself saying the transaction is not paid (e.g. Unpaid, Refunded). */
function isDefiniteNotPaid(res: CheckResult | null): boolean {
  return res?.ok === true && typeof res.status === "string" && res.status !== "Paid"
}

function indeterminateReason(res: CheckResult | null, thrown: string | null): string {
  if (thrown) return thrown
  if (!res) return "no response"
  if (!res.ok) return res.error ?? "status check not ok"
  if (res.status === "Paid") return "reported Paid but the payment could not be recorded"
  return "no status"
}

export async function runStatusChecks(args: {
  store: HubtelTxStore
  handlers: OrderHandlers
  failHandlers: OrderHandlers
  check: StatusChecker
  now?: number
  limit?: number
  /** Absolute epoch ms. Once Date.now() passes it, no new row (sweep or check) is started. */
  deadlineMs?: number
}): Promise<{ checked: number; paid: number; expired: number; swept: number; held: number; recovered: number }> {
  const now = args.now ?? Date.now()
  const out = { checked: 0, paid: 0, expired: 0, swept: 0, held: 0, recovered: 0 }
  const outOfTime = () => args.deadlineMs != null && Date.now() > args.deadlineMs

  // Sweep: a crash between claim and the final update would leave a paid order
  // invisible in 'processing'. Surface it for review; the callback is still due.
  if (outOfTime()) return out
  const stale = await args.store.listStaleProcessing(STALE_PROCESSING_MINUTES, args.limit ?? 50)
  for (const row of stale) {
    if (outOfTime()) return out
    try {
      // The row may have been finished since it was listed: never clobber a final state.
      const fresh = await args.store.findBySession(row.session_id)
      if (!fresh || fresh.state !== "processing") continue
      await args.store.update(row.session_id, {
        state: "needs_review",
        callback_status: "pending",
        // Bounds the callback window (callbacks expire 55 min after paid_at).
        paid_at: fresh.paid_at ?? new Date().toISOString(),
        callback_last_error: "recovered from stale processing; Hubtel order id may be missing",
      })
      console.error("[HUBTEL-STATUS] stale processing row moved to needs_review:", row.session_id)
      out.swept++
    } catch (e) { console.error("[HUBTEL-STATUS] sweep error:", row.session_id, e) }
  }

  // Re-check rows parked by an indeterminate expiry check (relay may have recovered). A Paid
  // answer goes through processFulfillment, whose lost-claim recovery records the payment and
  // makes the callback due WITHOUT running the order handler. Anything else leaves the row alone.
  if (outOfTime()) return out
  const parked = await args.store.listIndeterminate(args.limit ?? 50)
  for (const row of parked) {
    if (outOfTime()) return out
    try {
      if (indeterminateRecheckDisposition(row, now) !== "check") continue
      let res: CheckResult | null = null
      try { res = await args.check(row.session_id) } catch (e) {
        console.error("[HUBTEL-STATUS] indeterminate re-check error:", row.session_id, e)
      }
      await args.store.update(row.session_id, {
        status_check_attempts: row.status_check_attempts + 1,
        last_status_check_at: new Date(now).toISOString(),
      })
      if (!res?.ok || res.status !== "Paid") continue
      const d = res.data ?? {}
      const outcome = await processFulfillment(args.store, args.handlers, {
        sessionId: row.session_id,
        hubtelOrderId: typeof d.transactionId === "string" ? d.transactionId : null,
        amountPaid: Number(d.amount ?? 0),
        amountAfterCharges: Number(d.amountAfterCharges ?? 0),
        isSuccessful: true,
      })
      if (outcome === "needs_review") {
        console.warn("[HUBTEL-STATUS] indeterminate row now Paid; payment recorded, callback due:", row.session_id)
        out.recovered++
      } else {
        console.warn("[HUBTEL-STATUS] indeterminate row Paid but not recovered:", row.session_id, "outcome:", outcome)
      }
    } catch (e) { console.error("[HUBTEL-STATUS] indeterminate re-check row error:", row.session_id, e) }
  }

  if (outOfTime()) return out
  const rows = await args.store.listAwaitingPayment(args.limit ?? 50)

  // Shared Paid handling for the normal check path and the final pre-expiry check.
  // Returns true when the row was resolved as paid (fulfilled or held for review).
  const handlePaid = async (row: HubtelTxRow, res: CheckResult): Promise<boolean> => {
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
    if (outOfTime()) break
    try {
      const disposition = statusCheckDisposition(row, now)
      if (disposition === "skip") continue

      if (disposition === "expire") {
        // One last look: the customer may have paid and the webhook never arrived.
        let finalRes: CheckResult | null = null
        let finalErr: string | null = null
        try { finalRes = await args.check(row.session_id) } catch (e) {
          finalErr = e instanceof Error ? e.message : String(e)
          console.error("[HUBTEL-STATUS] final check error:", row.session_id, e)
        }
        if (finalRes && (await handlePaid(row, finalRes))) { out.paid++; continue }

        // Only a definite "not paid" from Hubtel may expire the row. If we could not learn the
        // status (relay down, 401, IP not whitelisted, timeout, odd shape) a paid customer whose
        // webhook was lost must not be marked failed: hold it for a human instead.
        const definite = isDefiniteNotPaid(finalRes)
        const patch: Partial<HubtelTxRow> = definite
          ? { state: "failed", callback_status: "not_due" } // never paid ⇒ no fulfilment, no callback due
          : {
              state: "needs_review",
              callback_status: "not_due",
              callback_last_error: `status check indeterminate at expiry: ${indeterminateReason(finalRes, finalErr)}`,
            }

        // Race-safe: only act if we win the claim; otherwise a webhook owns the row.
        if (!(await args.store.claim(row.session_id))) continue
        try {
          await args.store.update(row.session_id, patch)
        } catch (e) {
          console.error("[HUBTEL-STATUS] expiry update failed, reverting:", row.session_id, e)
          try { await args.store.update(row.session_id, { state: "awaiting_payment" }) } catch (e2) {
            console.error("[HUBTEL-STATUS] expiry revert failed:", row.session_id, e2)
          }
          continue
        }
        if (!definite) {
          console.error("[HUBTEL-STATUS] status indeterminate at expiry, held for review:", JSON.stringify({
            session_id: row.session_id, order_table: row.order_table, order_id: row.order_id, reason: patch.callback_last_error,
          }))
          out.held++
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
