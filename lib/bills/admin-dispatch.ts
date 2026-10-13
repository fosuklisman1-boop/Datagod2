import { canDispatch, isStuckClaim, type LedgerFact, type RefundOrderFacts } from "./admin"

export interface DispatchOrder extends RefundOrderFacts { id: string; reference_code: string; biller?: string; created_at?: string }

/** The Hubtel Ghana Water sessionId is per-lookup; a paid order older than this cannot safely be sent late. */
export const GHANA_WATER_MAX_AGE_MS = 10 * 60_000

export interface BillDispatchDeps {
  getOrder(id: string): Promise<DispatchOrder | null>
  getLedger(orderId: string): Promise<LedgerFact[]>
  /** Guarded processing -> pending with a "Released stuck dispatch claim" note; rows changed. */
  releaseStuckClaim(orderId: string): Promise<number>
  /** Guarded pending -> processing (ref when known); rows changed. Undoes a release. */
  restoreProcessing(orderId: string, ref: string | null): Promise<number>
  /** The service's dispatchBillOrder (claims atomically); returns the resulting status. */
  dispatch(order: DispatchOrder): Promise<string>
  alert(message: string, urgent?: boolean): Promise<void>
  now(): number
}

export interface BillDispatchResult { ok: boolean; status: number; message: string; released?: boolean; orderStatus?: string }

const safe = async (d: BillDispatchDeps, m: string, urgent = false) => { try { await d.alert(m, urgent) } catch { /* never break the flow */ } }

/** The dispatch route's decision flow with all IO injected. */
export async function executeBillDispatch(d: BillDispatchDeps, orderId: string): Promise<BillDispatchResult> {
  let order = await d.getOrder(orderId)
  if (!order) return { ok: false, status: 404, message: "Order not found" }
  let ledger: LedgerFact[]
  try { ledger = await d.getLedger(orderId) } catch { return { ok: false, status: 503, message: "Could not read the Hubtel ledger; try again" } }

  if (order.biller === "ghana_water" && order.created_at && d.now() - Date.parse(order.created_at) > GHANA_WATER_MAX_AGE_MS && (canDispatch(order) || isStuckClaim(order, ledger, d.now()))) {
    return { ok: false, status: 409, message: "Ghana Water verification expired — refund instead" }
  }

  let released = false
  if (isStuckClaim(order, ledger, d.now())) {
    if ((await d.releaseStuckClaim(orderId)) === 0) return { ok: false, status: 409, message: "Claim is no longer stuck" }
    released = true
    const rows = await d.getLedger(orderId).catch(() => null)
    if (rows === null || rows.length > 0) {
      const ref = rows?.[0]?.client_reference ?? null
      let back = 0
      try { back = await d.restoreProcessing(orderId, ref) } catch { back = 0 }
      await safe(d, back === 0
        ? `URGENT: bill order ${order.reference_code} (${orderId}) had its stuck claim released, a Hubtel transaction${ref ? ` (${ref})` : " may have"} appeared, and it could NOT be put back to processing. Fix by hand; do not resend.`
        : `Bill order ${order.reference_code}: a Hubtel transaction${ref ? ` (${ref})` : ""} appeared while releasing a stuck claim. Dispatch aborted; order restored to processing.`, back === 0)
      return { ok: false, status: back === 0 ? 500 : 409, message: "A Hubtel transaction appeared for this order (or the ledger could not be read). Dispatch aborted; check Hubtel Commission.", released }
    }
    order = await d.getOrder(orderId)
    if (!order) return { ok: false, status: 404, message: "Order not found", released }
  } else if (ledger.length > 0) {
    return { ok: false, status: 409, message: "A Hubtel transaction already exists for this order; resolve it in Hubtel Commission instead of dispatching" }
  }
  if (!canDispatch(order)) return { ok: false, status: 409, message: "Only paid, pending orders that were never sent can be dispatched", released }
  const status = await d.dispatch(order)
  return { ok: status !== "pending", status: 200, orderStatus: status, released, message: status === "pending" ? "The order is still pending; check its notes before trying again" : `Dispatched; order is ${status}` }
}
