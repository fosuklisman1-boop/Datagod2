import type { SupabaseClient } from "@supabase/supabase-js"
import type { HubtelCsState } from "@/lib/hubtel-cs/types"
import { isBillerKey } from "./billers"

export const BILL_ORDERS_TABLE = "hubtel_bill_orders"
export const ORDER_STATUSES = ["pending", "processing", "completed", "failed", "refunded"] as const
/** A pending+paid order younger than this may still be mid-dispatch, so it cannot be refunded as "never sent". */
export const UNSENT_GRACE_MS = 60_000
/** A dispatch claim older than this with no Hubtel ledger row never reached Hubtel (the ledger row is written before the POST). */
export const STUCK_CLAIM_MS = 300_000
export const STUCK_REASON = "Stuck dispatch (never reached Hubtel)"

export interface OrderFilters {
  q?: string
  status?: string
  biller?: string
  paidOnly: boolean
  from?: string
  to?: string
  view: "all" | "refund" | "refunded"
  channel?: "dashboard" | "storefront" | "api" | "bots"
}

/** Validates every query-string value; unknown values are dropped rather than passed to the database. */
export function parseOrderFilters(sp: URLSearchParams): OrderFilters {
  const status = sp.get("status") ?? ""
  const biller = sp.get("biller") ?? ""
  const dateOk = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined)
  const view = sp.get("view")
  // PostgREST .or() syntax breaks on these characters; they never appear in references, accounts or phones.
  const q = (sp.get("q") ?? "").replace(/[,()%*\\"']/g, " ").trim().slice(0, 100)
  return {
    q: q || undefined,
    status: (ORDER_STATUSES as readonly string[]).includes(status) ? status : undefined,
    biller: isBillerKey(biller) ? biller : undefined,
    paidOnly: sp.get("paidOnly") === "true" || sp.get("paidOnly") === "1",
    from: dateOk(sp.get("from")),
    to: dateOk(sp.get("to")),
    view: view === "refund" || view === "refunded" ? view : "all",
    channel: ["dashboard", "storefront", "api", "bots"].includes(sp.get("channel") ?? "") ? (sp.get("channel") as "dashboard" | "storefront" | "api" | "bots") : undefined,
  }
}

/** Builds the shared filter onto a select query (used by the page query and the stats query alike). */
export function applyOrderFilters<T>(query: T, f: OrderFilters, qAlt?: string): T {
  let q: any = query
  if (f.view === "refund") {
    q = q.eq("payment_status", "paid").or("status.in.(failed,pending),and(status.eq.processing,notes.ilike.Dispatching%,hubtel_client_reference.is.null)")
  }
  else if (f.view === "refunded") q = q.eq("status", "refunded")
  if (f.status) q = q.eq("status", f.status)
  if (f.biller) q = q.eq("biller", f.biller)
  if (f.channel) q = q.eq("channel", f.channel)
  if (f.paidOnly) q = q.eq("payment_status", "paid")
  if (f.from) q = q.gte("created_at", `${f.from}T00:00:00.000Z`)
  if (f.to) q = q.lte("created_at", `${f.to}T23:59:59.999Z`)
  if (f.q) {
    const t = f.q
    const parts = [`reference_code.ilike.%${t}%`, `account_number.ilike.%${t}%`, `hubtel_client_reference.ilike.%${t}%`, `customer_name.ilike.%${t}%`]
    if (qAlt) parts.push(`phone.eq.${qAlt}`, `phone.ilike.%${t}%`)
    q = q.or(parts.join(","))
  }
  return q as T
}

export interface StatRow { amount: number | string; status: string; payment_status: string; commission: number | string | null }
export interface OrderStats {
  totalSales: number; orders: number; completed: number; inFlight: number; commission: number; failed: number; refunded: number
}

/** Totals over every row of the filtered window. Sales = money still held for a purchase (paid, not failed/refunded). */
export function computeStats(rows: StatRow[]): OrderStats {
  const s: OrderStats = { totalSales: 0, orders: 0, completed: 0, inFlight: 0, commission: 0, failed: 0, refunded: 0 }
  let cents = 0
  let commissionMicro = 0
  for (const r of rows) {
    s.orders++
    const paid = r.payment_status === "paid"
    if (r.status === "completed") s.completed++
    else if (r.status === "failed") s.failed++
    else if (r.status === "refunded") s.refunded++
    else if (paid && (r.status === "pending" || r.status === "processing")) s.inFlight++
    if (paid && (r.status === "completed" || r.status === "pending" || r.status === "processing")) cents += Math.round(Number(r.amount) * 100)
    if (r.status === "completed" && r.commission !== null && r.commission !== undefined) commissionMicro += Math.round(Number(r.commission) * 1e6)
  }
  s.totalSales = cents / 100
  s.commission = commissionMicro / 1e6
  return s
}

/** Arguments for the hubtel_bill_orders_stats RPC. A phone-style search is sent in its stored 233 form. */
export function statsRpcArgs(f: OrderFilters, qAlt?: string) {
  return {
    p_from: f.from ? `${f.from}T00:00:00.000Z` : null,
    p_to: f.to ? `${f.to}T23:59:59.999Z` : null,
    p_biller: f.biller ?? null,
    p_status: f.status ?? null,
    p_q: qAlt ?? f.q ?? null,
    p_paid_only: f.paidOnly,
  }
}

/** RPC row (snake_case, bigint/numeric may arrive as strings) -> OrderStats. */
export function statsFromRpc(r: any): OrderStats {
  const n = (v: unknown) => { const x = Number(v ?? 0); return Number.isFinite(x) ? x : 0 }
  return {
    totalSales: n(r?.total_sales), orders: n(r?.orders), completed: n(r?.completed), inFlight: n(r?.in_flight),
    commission: n(r?.commission), failed: n(r?.failed), refunded: n(r?.refunded),
  }
}

/** One aggregate query over the whole filtered window. Throws on error (callers degrade to stats: null). */
export async function fetchStats(db: SupabaseClient, f: OrderFilters, qAlt?: string): Promise<OrderStats> {
  const { data, error } = await db.rpc("hubtel_bill_orders_stats", statsRpcArgs(f, qAlt))
  if (error) throw error
  return statsFromRpc(Array.isArray(data) ? data[0] : data)
}

/** Purchaser display, same source as the airtime admin list (users.email), plus a name when present. */
export function purchaserLabel(u: { email?: string | null; first_name?: string | null; last_name?: string | null } | undefined): string {
  if (!u) return "Unknown"
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim()
  return name || u.email || "Unknown"
}

// ---------------------------------------------------------------------------------------------
// Refund decision (pure). Never refund anything Hubtel may still deliver or already delivered.
// ---------------------------------------------------------------------------------------------

export interface LedgerFact {
  client_reference: string
  state: HubtelCsState
  refund_claimed_at: string | null
  resolved_by: string | null
  created_at: string
}
export interface RefundOrderFacts {
  status: string
  payment_status: string
  hubtel_client_reference: string | null
  notes: string | null
  updated_at: string
}
export type RefundDecision =
  | { action: "blocked"; reason: string }
  | { action: "ledger"; ref: string; needsForce: boolean }
  | { action: "direct"; markFailedFirst: boolean; releaseStuck?: boolean }

/** processing + paid + no ref + no ledger rows + a "Dispatching" note older than 5 minutes. */
export function isStuckClaim(order: RefundOrderFacts, ledgerRows: LedgerFact[], now: number = Date.now()): boolean {
  return order.status === "processing" && order.payment_status === "paid" && !order.hubtel_client_reference &&
    ledgerRows.length === 0 && (order.notes ?? "").startsWith("Dispatching") && now - Date.parse(order.updated_at) >= STUCK_CLAIM_MS
}

export function refundDecision(order: RefundOrderFacts, ledger: LedgerFact[], now: number = Date.now()): RefundDecision {
  const blocked = (reason: string): RefundDecision => ({ action: "blocked", reason })
  if (order.status === "refunded" || order.payment_status === "refunded") return blocked("Already refunded")
  if (order.status === "completed") return blocked("Completed orders cannot be refunded")
  if (order.payment_status !== "paid") return blocked("This order was never paid")
  if (ledger.some(l => l.state === "fulfilled")) return blocked("Hubtel delivered this bill; it cannot be refunded")
  const live = ledger.find(l => l.state === "pending" || l.state === "needs_review" || l.state === "created")
  if (live) return blocked(`Hubtel transaction ${live.client_reference} is ${live.state.replace("_", " ")} and may still deliver. Resolve it in Hubtel Commission first.`)
  if (order.hubtel_client_reference && !ledger.some(l => l.client_reference === order.hubtel_client_reference)) {
    return blocked("The Hubtel ledger row for this order could not be found; check Hubtel Commission before refunding")
  }
  if (isStuckClaim(order, ledger, now)) return { action: "direct", markFailedFirst: true, releaseStuck: true }
  if (order.status === "processing") {
    return blocked((order.notes ?? "").startsWith("Dispatching") && !order.hubtel_client_reference
      ? "A dispatch is in progress; if it never finishes it can be released after 5 minutes"
      : "Still processing; use Sync first")
  }
  if (ledger.length > 0) {
    // All remaining rows are failed. Newest first.
    const latest = [...ledger].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
    if (order.status !== "failed") return blocked("Hubtel reports this failed but the order is not marked failed yet; use Sync first")
    if (latest.refund_claimed_at) return blocked("A refund was already claimed for this order; check the customer's wallet before any retry")
    return { action: "ledger", ref: latest.client_reference, needsForce: !!latest.resolved_by }
  }
  // Never reached Hubtel.
  if (order.status === "failed") return { action: "direct", markFailedFirst: false }
  if (order.status === "pending") {
    const age = now - Date.parse(order.updated_at)
    if (!(age >= UNSENT_GRACE_MS)) return blocked("This order was updated moments ago and may still be dispatching; try again in a minute")
    return { action: "direct", markFailedFirst: true }
  }
  return blocked("This order cannot be refunded")
}

/** Dispatch is only for debited-but-unsent orders. */
export const canDispatch = (o: { status: string; payment_status: string; hubtel_client_reference: string | null }, stuck = false): boolean =>
  stuck || (o.status === "pending" && o.payment_status === "paid" && !o.hubtel_client_reference)

/**
 * Retry is for paid orders Hubtel itself failed: every attempt is a failed ledger row, no refund has been claimed
 * against any of them, and none was failed by an admin override (that one may in fact have been delivered).
 * The database allows a new transaction once all earlier ones are failed (hubtel_cs_tx_order_active_uidx).
 */
export function retryDecision(order: { status: string; payment_status: string }, ledger: LedgerFact[]): { ok: true } | { ok: false; reason: string } {
  if (order.status !== "failed" || order.payment_status !== "paid") return { ok: false, reason: "Only paid, failed orders can be retried" }
  if (ledger.length === 0) return { ok: false, reason: "This order never reached Hubtel; refund it instead" }
  if (ledger.some(l => l.state !== "failed")) return { ok: false, reason: "A Hubtel transaction for this order is not failed; resolve it in Hubtel Commission first" }
  if (ledger.some(l => l.refund_claimed_at)) return { ok: false, reason: "A refund was already claimed for this order; it cannot be retried" }
  if (ledger.some(l => l.resolved_by)) return { ok: false, reason: "An attempt was marked failed by an admin override, not by Hubtel; it may have been delivered" }
  return { ok: true }
}

/** Ledger rows per bill order (newest first). Throws on DB error: callers must fail closed. */
export async function fetchLedgerByOrders(db: SupabaseClient, orderIds: string[]): Promise<Map<string, LedgerFact[]>> {
  const out = new Map<string, LedgerFact[]>()
  if (orderIds.length === 0) return out
  const { data, error } = await db.from("hubtel_cs_transactions")
    .select("order_id, client_reference, state, refund_claimed_at, resolved_by, created_at")
    .eq("order_table", BILL_ORDERS_TABLE).in("order_id", orderIds.slice(0, 200)).order("created_at", { ascending: false })
  if (error) throw error
  for (const r of (data ?? []) as any[]) {
    const list = out.get(r.order_id) ?? []
    list.push({ client_reference: r.client_reference, state: r.state, refund_claimed_at: r.refund_claimed_at, resolved_by: r.resolved_by, created_at: r.created_at })
    out.set(r.order_id, list)
  }
  return out
}

/**
 * Release a stuck dispatch claim (processing -> pending), fully guarded in SQL so a stale request can never
 * release another admin's fresh live claim. Returns rows changed (0 => the claim is no longer stuck).
 */
export async function releaseStuckClaimRow(db: SupabaseClient, orderId: string, adminId: string, now: number = Date.now()): Promise<number> {
  const { data, error } = await db.from(BILL_ORDERS_TABLE)
    .update({ status: "pending", notes: `Released stuck dispatch claim by admin ${adminId}`, updated_at: new Date(now).toISOString() })
    .eq("id", orderId)
    .eq("status", "processing")
    .eq("payment_status", "paid")
    .is("hubtel_client_reference", null)
    .like("notes", "Dispatching%")
    .lt("updated_at", new Date(now - STUCK_CLAIM_MS).toISOString())
    .select("id")
  if (error) throw error
  return data?.length ?? 0
}
