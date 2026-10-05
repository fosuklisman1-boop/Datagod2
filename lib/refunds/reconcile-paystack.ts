/**
 * Cron worker: re-checks Paystack reversals parked in `processing` and lets reconcileRefund settle them.
 * reconcileRefund settles ONLY on an explicit `processed` (-> completed) or `failed` (-> compensate); pending /
 * unknown / needs-attention just re-mark processing. This adds no new write paths.
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

export async function reconcileProcessingPaystackRefunds(deps: RefundDeps, rows: StoredRefund[], now: number = Date.now()): Promise<ReconcileRunResult> {
  const r: ReconcileRunResult = { checked: 0, completed: 0, failed: 0, stillProcessing: 0, errors: 0, skipped: 0, stale24h: 0 }
  for (const row of rows) {
    if (row.gateway !== "paystack" || row.status !== "processing" || !isLookupableRefundId(row.gateway_ref)) { r.skipped++; continue }
    if (r.checked >= MAX_PER_RUN) break
    r.checked++
    try {
      const out = await reconcileRefund(deps, row)
      if (out.status === "completed") r.completed++
      else if (out.status === "failed") r.failed++
      else {
        r.stillProcessing++
        const t = Date.parse(row.updated_at)
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
