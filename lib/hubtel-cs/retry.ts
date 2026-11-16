import type { SupabaseClient } from "@supabase/supabase-js"
import type { LedgerFact } from "@/lib/bills/admin"
import type { HubtelCsTx } from "./types"

/** Order tables whose failed Hubtel attempts can be re-sent from the Hubtel Commission review queue. */
export const RETRYABLE_ORDER_TABLES: ReadonlySet<string> = new Set(["airtime_orders", "hubtel_bill_orders", "hubtel_data_orders"])

type TxFacts = Pick<HubtelCsTx, "client_reference" | "state" | "order_table" | "order_id" | "refund_claimed_at" | "resolved_by">
export type RetryCheck = { ok: true } | { ok: false; reason: string }

// Ties (same millisecond) break on the reference so the order is deterministic.
const newestFirst = (ledger: LedgerFact[]) => [...ledger].sort((a, b) =>
  Date.parse(b.created_at) - Date.parse(a.created_at) || b.client_reference.localeCompare(a.client_reference))

/**
 * Ledger-level gate shared by every product. A retry is a NEW Hubtel transaction, so it is only safe when every
 * earlier attempt for the order is failed by Hubtel itself, nothing was refunded, and this row is the newest attempt.
 * The order-level checks (paid, still failed/pending, not refunding) are done by each product's retry executor.
 * The DB index hubtel_cs_tx_order_active_uidx is the final guard: it allows only one non-failed attempt per order.
 */
export function ledgerRetryCheck(tx: TxFacts, ledger: LedgerFact[]): RetryCheck {
  const no = (reason: string): RetryCheck => ({ ok: false, reason })
  if (tx.state !== "failed") return no("Only failed transactions can be retried")
  if (!tx.order_table || !tx.order_id) return no("This transaction is not linked to an order (admin test purchase); nothing to retry")
  if (!RETRYABLE_ORDER_TABLES.has(tx.order_table)) return no(`No retry handler for ${tx.order_table}`)
  if (tx.refund_claimed_at) return no("A refund was already claimed for this transaction; it cannot be retried")
  if (tx.resolved_by) return no("This attempt was marked failed by an admin override, not by Hubtel; it may have been delivered")
  const sorted = newestFirst(ledger)
  if (!sorted.some(l => l.client_reference === tx.client_reference)) return no("Could not read this order's Hubtel attempts; try again")
  if (sorted[0].client_reference !== tx.client_reference) return no(`A newer attempt exists for this order (${sorted[0].client_reference}, ${sorted[0].state.replace("_", " ")})`)
  if (sorted.some(l => l.state !== "failed")) return no("Another Hubtel attempt for this order is not failed; resolve it first")
  if (sorted.some(l => l.refund_claimed_at)) return no("A refund was already claimed for this order; it cannot be retried")
  if (sorted.some(l => l.resolved_by)) return no("An attempt was marked failed by an admin override, not by Hubtel; it may have been delivered")
  // Bill/data onFailed does not check which attempt is current: an unsynced old row replayed by the cron sweep
  // would flip the retry's live order to failed (and re-open its refund). Wait until the sweep has synced it.
  if (sorted.some(l => l.order_synced_at === null)) return no("The last failure has not finished syncing to the order yet; try again in a few minutes")
  return { ok: true }
}

/** The newest LATER attempt for the same order, or null when this row is the latest. */
export function supersededBy(tx: Pick<HubtelCsTx, "client_reference">, ledger: LedgerFact[]): { ref: string; state: string } | null {
  const sorted = newestFirst(ledger)
  const idx = sorted.findIndex(l => l.client_reference === tx.client_reference)
  if (idx <= 0) return null
  return { ref: sorted[0].client_reference, state: sorted[0].state }
}

/** Ledger rows for one order (any table). Throws on DB error: callers must fail closed. */
export async function fetchOrderLedger(db: SupabaseClient, orderTable: string, orderId: string): Promise<LedgerFact[]> {
  return (await fetchLedgersFor(db, [{ order_table: orderTable, order_id: orderId }])).get(`${orderTable}:${orderId}`) ?? []
}

/** Ledger rows keyed by `${order_table}:${order_id}`. Throws on DB error. */
export async function fetchLedgersFor(db: SupabaseClient, rows: { order_table: string | null; order_id: string | null }[]): Promise<Map<string, LedgerFact[]>> {
  const out = new Map<string, LedgerFact[]>()
  const ids = [...new Set(rows.filter(r => r.order_table && r.order_id).map(r => r.order_id as string))].slice(0, 200)
  if (ids.length === 0) return out
  const { data, error } = await db.from("hubtel_cs_transactions")
    .select("order_table, order_id, client_reference, state, refund_claimed_at, resolved_by, created_at, order_synced_at")
    .in("order_id", ids)
  if (error) throw error
  for (const r of (data ?? []) as any[]) {
    const key = `${r.order_table}:${r.order_id}`
    const list = out.get(key) ?? []
    list.push({ client_reference: r.client_reference, state: r.state, refund_claimed_at: r.refund_claimed_at, resolved_by: r.resolved_by, created_at: r.created_at, order_synced_at: r.order_synced_at ?? null })
    out.set(key, list)
  }
  return out
}
