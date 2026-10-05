/**
 * Cron worker: re-checks Paystack reversals AND Paystack MoMo payouts parked in `processing` and lets
 * reconcileRefund settle them. reconcileRefund settles ONLY on an explicit success (-> completed) or failure
 * (-> compensate); pending / unknown / needs-attention just re-mark processing. This adds no new write paths.
 * Not covered: `awaiting_otp` (needs an admin OTP), `reserved`, and Moolre.
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
 */
function isProcessable(row: StoredRefund): boolean {
  if (row.status !== "processing") return false
  if (row.gateway === "paystack") return isLookupableRefundId(row.gateway_ref)
  return row.gateway === "paystack_payout"
}

export async function reconcileProcessingPaystackRefunds(deps: RefundDeps, rows: StoredRefund[], now: number = Date.now()): Promise<ReconcileRunResult> {
  const r: ReconcileRunResult = { checked: 0, completed: 0, failed: 0, stillProcessing: 0, errors: 0, skipped: 0, stale24h: 0 }
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
  return r
}
