/**
 * Cron worker: re-checks Paystack reversals, Paystack MoMo payouts AND Moolre MoMo payouts parked in `processing` and lets
 * reconcileRefund settle them. reconcileRefund settles ONLY on an explicit success (-> completed) or failure
 * (-> compensate); pending / unknown / needs-attention just re-mark processing. This adds no new write paths.
 * Not covered: `awaiting_otp` (needs an admin OTP) and `reserved`.
 */
import { isLookupableRefundId } from "./gateways/paystack"
import { RefundError, reconcileRefund, type RefundDeps, type StoredRefund } from "./service"

export const MAX_PER_RUN = 25
const STALE_MS = 24 * 3_600_000

export interface ReconcileRunResult {
  checked: number
  completed: number
  failed: number
  stillProcessing: number
  errors: number
  skipped: number
  stale24h: number
}

/**
 * Reversals are looked up by the numeric Paystack refund id (gateway_ref). Payouts are looked up by the transfer
 * reference = our refund id (see paystack-payout checkStatus), so their gateway_ref (TRF_ code or null) is irrelevant.
 * Moolre payouts are likewise looked up by externalref = our refund id (see moolre checkStatus).
 */
function isProcessable(row: StoredRefund): boolean {
  if (row.status !== "processing") return false
  if (row.gateway === "paystack") return isLookupableRefundId(row.gateway_ref)
  // Hubtel Send Money payouts are looked up by the refund id (their ClientReference), after Hubtel's 5 minutes
  // (reconcileRefund waits that out). A `pending` one past 24 hours alerts admins and changes nothing.
  return row.gateway === "paystack_payout" || row.gateway === "moolre" || row.gateway === "hubtel_send"
}

/** Ids only: no number, no amount. Says what to do: the row has its own actions on /admin/refunds. */
export function staleHubtelSendAlert(stale: Pick<StoredRefund, "id">[]): string {
  const ids = stale.slice(0, 5).map((r) => r.id.slice(0, 8)).join(", ")
  return `${stale.length} Hubtel payout refund(s) still unconfirmed after 24 hours (${ids}). On /admin/refunds, History: press "Hubtel status" to see what Hubtel says. If it failed or has no record, use "Hubtel confirms this never paid: mark failed", then Retry. If it says paid, check Hubtel and contact the developer.`
}

export interface ReconcileOptions {
  /** Called once per run with the hubtel_send refunds still unsettled 24 hours after creation. Never allowed to throw into the run. */
  onStaleHubtelSend?: (rows: StoredRefund[]) => Promise<void>
}

export async function reconcileProcessingPaystackRefunds(
  deps: RefundDeps, rows: StoredRefund[], now: number = Date.now(), opts: ReconcileOptions = {},
): Promise<ReconcileRunResult> {
  const r: ReconcileRunResult = { checked: 0, completed: 0, failed: 0, stillProcessing: 0, errors: 0, skipped: 0, stale24h: 0 }
  const staleHubtel: StoredRefund[] = []
  for (const row of rows) {
    if (!isProcessable(row)) { r.skipped++; continue }
    if (r.checked >= MAX_PER_RUN) break
    r.checked++
    try {
      const out = await reconcileRefund(deps, row)
      if (out.status === "completed") r.completed++
      else if (out.status === "failed") r.failed++
      else {
        r.stillProcessing++
        // Measured from creation: updated_at is bumped by every re-check, so it would never go stale.
        const t = Date.parse(row.created_at ?? "")
        if (Number.isFinite(t) && now - t >= STALE_MS) {
          r.stale24h++
          console.error(`[REFUND-CRON] needs attention: ${row.id}`)
          if (row.gateway === "hubtel_send") staleHubtel.push(row)
        }
      }
    } catch (err) {
      if (err instanceof RefundError && err.code === "SETTLE_FAILED") {
        r.errors++
        console.error(`[REFUND-CRON] SETTLE_FAILED for refund ${row.id}:`, err.message, err.detail)
      } else if (err instanceof RefundError && (err.code === "IN_FLIGHT" || err.code === "NOT_FOUND")) {
        r.stillProcessing++
        console.warn(`[REFUND-CRON] ${err.code} for refund ${row.id}: ${err.message}`)
      } else {
        r.errors++
        console.error(`[REFUND-CRON] unexpected error for refund ${row.id}:`, err)
      }
    }
  }
  if (staleHubtel.length > 0 && opts.onStaleHubtelSend) {
    try {
      await opts.onStaleHubtelSend(staleHubtel)
    } catch (err) {
      console.error("[REFUND-CRON] stale Hubtel payout alert failed:", err instanceof Error ? err.name : "unknown")
    }
  }
  return r
}
