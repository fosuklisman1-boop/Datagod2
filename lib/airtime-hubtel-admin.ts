import type { SupabaseClient } from "@supabase/supabase-js"
import type { AirtimeOrderMinimal } from "@/lib/airtime-hubtel"
import type { LedgerFact } from "@/lib/bills/admin"

const AIRTIME_ORDERS_TABLE = "airtime_orders"
const LEDGER_CHUNK = 200

/**
 * A pending order updated more recently than this may still be mid-dispatch: wallet/Paystack airtime on Digiwapy
 * networks stays `pending` with no ledger row and no dgwRef while Digiwapy is being called (30s timeout + retries).
 */
export const AIRTIME_SEND_GRACE_MS = 180_000
/**
 * A Digiwapy attempt whose outcome is unclear: the request was sent but timed out / aborted, or Digiwapy answered with
 * a server error or an unparseable body. It may have been delivered. A plain "fetch failed" never opened the connection.
 */
const DIGIWAPY_UNCLEAR = /digiwapy error:.*(abort|timeout|timed out|http 5\d\d|unexpected token|json)/i
const NOTES_MAX = 900

export interface AirtimeSendOrder extends AirtimeOrderMinimal {
  status: string
  payment_status: string
  notes?: string | null
  updated_at: string
}

export interface AirtimeSendDeps {
  getOrder(id: string): Promise<AirtimeSendOrder | null>
  getLedger(orderId: string): Promise<LedgerFact[]>
  /** fulfillAirtimeViaHubtel with the real deps: true = Hubtel owns it now, false = nothing was sent. */
  send(order: AirtimeSendOrder): Promise<boolean>
  alert(message: string, urgent?: boolean): Promise<void>
  /** Clock for the dispatch grace; defaults to Date.now. */
  now?(): number
}

export interface AirtimeSendResult { ok: boolean; status: number; message: string; orderStatus?: string }

/**
 * Whether an admin may send this airtime order to Hubtel. Airtime's Hubtel failure convention returns the order
 * to 'pending', so "never sent" and "Hubtel failed it" are one case. Checked in this order:
 * paid + pending; not updated within the dispatch grace (an unparseable updated_at is refused); every Hubtel
 * attempt failed (zero rows = never sent); no refund claim; no admin-overridden failure (it may have been
 * delivered); no Digiwapy reference (Digiwapy accepted it once); no unclear Digiwapy attempt (timeout/5xx).
 */
export function airtimeSendDecision(
  order: Pick<AirtimeSendOrder, "status" | "payment_status" | "notes" | "updated_at">,
  ledger: LedgerFact[],
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (order.payment_status !== "completed" || order.status !== "pending") return { ok: false, reason: "Only paid, pending airtime can be sent" }
  if (!(now - Date.parse(order.updated_at) >= AIRTIME_SEND_GRACE_MS)) {
    return { ok: false, reason: "This order was updated moments ago and may still be dispatching; try again in a few minutes" }
  }
  if (hasLiveHubtelAttempt(ledger)) return { ok: false, reason: "A Hubtel transaction for this order is not failed; resolve it in Hubtel Commission first" }
  if (ledger.some(l => l.refund_claimed_at)) return { ok: false, reason: "A refund was already claimed for this order" }
  if (ledger.some(l => l.resolved_by)) return { ok: false, reason: "An attempt was marked failed by an admin override, not by Hubtel; it may have been delivered" }
  const notes = order.notes ?? ""
  if (notes.includes("dgwRef:")) return { ok: false, reason: "Digiwapy already accepted this order (dgwRef); check Digiwapy before resending" }
  if (DIGIWAPY_UNCLEAR.test(notes)) {
    return { ok: false, reason: "A Digiwapy attempt ended unclear (timeout/server error); it may have been delivered. Check Digiwapy before resending" }
  }
  return { ok: true }
}

/** True when any Hubtel attempt for the order is not `failed` (live, in review, or delivered): never send elsewhere. */
export function hasLiveHubtelAttempt(ledger: LedgerFact[]): boolean {
  return ledger.some(l => l.state !== "failed")
}

/** A route-owned notes write that keeps the previous notes as evidence: `${next} | prev: ${prior}`, capped. */
export function appendPriorNotes(next: string, prior: string | null | undefined): string {
  const p = (prior ?? "").trim()
  if (!p) return next
  return `${next} | prev: ${p}`.slice(0, NOTES_MAX)
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
  const now = () => (d.now ? d.now() : Date.now())
  const initial = await d.getOrder(orderId)
  if (!initial) return { ok: false, status: 404, message: "Order not found" }
  const ledgerError: AirtimeSendResult = { ok: false, status: 503, message: "Could not read the Hubtel ledger; try again" }

  let ledger: LedgerFact[]
  try { ledger = await d.getLedger(orderId) } catch { return ledgerError }
  const first = airtimeSendDecision(initial, ledger, now())
  if (!first.ok) return { ok: false, status: 409, message: first.reason }

  try { ledger = await d.getLedger(orderId) } catch { return ledgerError }
  // Re-read the order too: it may have been refunded, sent or re-noted since the first read.
  let order: AirtimeSendOrder | null
  try { order = await d.getOrder(orderId) } catch { return { ok: false, status: 503, message: "Could not re-read the order; try again" } }
  if (!order) return { ok: false, status: 404, message: "Order not found" }
  const second = airtimeSendDecision(order, ledger, now())
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
