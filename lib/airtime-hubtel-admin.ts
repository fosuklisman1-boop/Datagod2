import type { SupabaseClient } from "@supabase/supabase-js"
import type { AirtimeOrderMinimal } from "@/lib/airtime-hubtel"
import type { LedgerFact } from "@/lib/bills/admin"

const AIRTIME_ORDERS_TABLE = "airtime_orders"
const LEDGER_CHUNK = 200

export interface AirtimeSendOrder extends AirtimeOrderMinimal {
  status: string
  payment_status: string
  notes?: string | null
}

export interface AirtimeSendDeps {
  getOrder(id: string): Promise<AirtimeSendOrder | null>
  getLedger(orderId: string): Promise<LedgerFact[]>
  /** fulfillAirtimeViaHubtel with the real deps: true = Hubtel owns it now, false = nothing was sent. */
  send(order: AirtimeSendOrder): Promise<boolean>
  alert(message: string, urgent?: boolean): Promise<void>
}

export interface AirtimeSendResult { ok: boolean; status: number; message: string; orderStatus?: string }

/**
 * Whether an admin may send this airtime order to Hubtel. Airtime's Hubtel failure convention returns the order
 * to 'pending', so "never sent" and "Hubtel failed it" are one case. Checked in this order:
 * paid + pending; every Hubtel attempt failed (zero rows = never sent); no refund claim; no admin-overridden
 * failure (it may have been delivered); no Digiwapy reference (Digiwapy accepted it once).
 */
export function airtimeSendDecision(
  order: Pick<AirtimeSendOrder, "status" | "payment_status" | "notes">,
  ledger: LedgerFact[],
): { ok: true } | { ok: false; reason: string } {
  if (order.payment_status !== "completed" || order.status !== "pending") return { ok: false, reason: "Only paid, pending airtime can be sent" }
  if (ledger.some(l => l.state !== "failed")) return { ok: false, reason: "A Hubtel transaction for this order is not failed; resolve it in Hubtel Commission first" }
  if (ledger.some(l => l.refund_claimed_at)) return { ok: false, reason: "A refund was already claimed for this order" }
  if (ledger.some(l => l.resolved_by)) return { ok: false, reason: "An attempt was marked failed by an admin override, not by Hubtel; it may have been delivered" }
  if ((order.notes ?? "").includes("dgwRef:")) return { ok: false, reason: "Digiwapy already accepted this order (dgwRef); check Digiwapy before resending" }
  return { ok: true }
}

/**
 * Hubtel ledger rows for airtime orders, newest first, grouped by order id. Throws on a DB error.
 * Reads every id in chunks: silently dropping ids would make the list route show a Send button it should not.
 */
export async function fetchAirtimeLedgerByOrders(db: SupabaseClient, orderIds: string[]): Promise<Map<string, LedgerFact[]>> {
  const out = new Map<string, LedgerFact[]>()
  for (let i = 0; i < orderIds.length; i += LEDGER_CHUNK) {
    const { data, error } = await db.from("hubtel_cs_transactions")
      .select("order_id, client_reference, state, refund_claimed_at, resolved_by, created_at")
      .eq("order_table", AIRTIME_ORDERS_TABLE).in("order_id", orderIds.slice(i, i + LEDGER_CHUNK)).order("created_at", { ascending: false })
    if (error) throw error
    for (const r of (data ?? []) as any[]) {
      const list = out.get(r.order_id) ?? []
      list.push({ client_reference: r.client_reference, state: r.state, refund_claimed_at: r.refund_claimed_at, resolved_by: r.resolved_by, created_at: r.created_at })
      out.set(r.order_id, list)
    }
  }
  return out
}

/**
 * Admin "Send via Hubtel" for a paid airtime order stuck in pending. Decides twice (the second time on a fresh
 * ledger read, just before sending), then hands the order to fulfillAirtimeViaHubtel, which never resends an
 * outcome-unknown order and owns every state change. Hubtel's one-live-transaction-per-order rule is the backstop.
 */
export async function executeAirtimeHubtelSend(d: AirtimeSendDeps, orderId: string): Promise<AirtimeSendResult> {
  const order = await d.getOrder(orderId)
  if (!order) return { ok: false, status: 404, message: "Order not found" }
  const ledgerError: AirtimeSendResult = { ok: false, status: 503, message: "Could not read the Hubtel ledger; try again" }

  let ledger: LedgerFact[]
  try { ledger = await d.getLedger(orderId) } catch { return ledgerError }
  const first = airtimeSendDecision(order, ledger)
  if (!first.ok) return { ok: false, status: 409, message: first.reason }

  try { ledger = await d.getLedger(orderId) } catch { return ledgerError }
  const second = airtimeSendDecision(order, ledger)
  if (!second.ok) return { ok: false, status: 409, message: second.reason }

  let sent: boolean
  try {
    sent = await d.send(order)
  } catch (e: any) {
    try {
      await d.alert(`URGENT: airtime order ${order.reference_code} (${orderId}): the admin Send via Hubtel failed unexpectedly (${e?.message ?? "error"}); it may or may not have reached Hubtel. Check the Hubtel ledger; do not resend until resolved.`, true)
    } catch { /* never break the flow */ }
    return { ok: false, status: 500, message: "The send failed unexpectedly and may have reached Hubtel. Admins were alerted; do not resend." }
  }

  const fresh = await d.getOrder(orderId).catch(() => null)
  if (!sent) {
    return { ok: false, status: 200, orderStatus: fresh?.status ?? order.status, message: `Not sent: ${fresh?.notes ?? order.notes ?? "unknown reason"}` }
  }
  const orderStatus = fresh?.status
  return { ok: true, status: 200, orderStatus, message: orderStatus ? `Sent to Hubtel; the order is ${orderStatus}` : "Sent to Hubtel" }
}
