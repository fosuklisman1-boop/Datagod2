import type { SupabaseClient } from "@supabase/supabase-js"
import { retryDecision, type LedgerFact } from "@/lib/bills/admin"
import { BUNDLE_NETWORKS } from "./categories"

export const DATA_ORDERS_TABLE = "hubtel_data_orders"
export const ORDER_STATUSES = ["pending", "processing", "completed", "failed", "refunded"] as const
/** A pending+paid order younger than this may still be mid-dispatch, so it cannot be refunded as "never sent". */
export const UNSENT_GRACE_MS = 60_000
/** A dispatch claim older than this with no Hubtel ledger row never reached Hubtel (the ledger row is written before the POST). */
export const STUCK_CLAIM_MS = 300_000

export interface OrderFilters {
  q?: string; status?: string; network?: string; from?: string; to?: string; channel?: "dashboard" | "storefront" | "api" | "bots"
  /** Special Bundles group (special_group_id, migration 0141). */
  group?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Validates every query-string value; unknown values are dropped rather than passed to the database. */
export function parseOrderFilters(sp: URLSearchParams): OrderFilters {
  const status = sp.get("status") ?? ""
  const network = sp.get("network") ?? ""
  const dateOk = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined)
  // PostgREST .or() syntax breaks on these characters; they never appear in references or phones.
  const q = (sp.get("q") ?? "").replace(/[,()%*\\"']/g, " ").trim().slice(0, 100)
  return {
    q: q || undefined,
    status: (ORDER_STATUSES as readonly string[]).includes(status) ? status : undefined,
    network: (BUNDLE_NETWORKS as readonly string[]).includes(network) ? network : undefined,
    from: dateOk(sp.get("from")),
    to: dateOk(sp.get("to")),
    channel: ["dashboard", "storefront", "api", "bots"].includes(sp.get("channel") ?? "") ? (sp.get("channel") as "dashboard" | "storefront" | "api" | "bots") : undefined,
    group: UUID_RE.test(sp.get("group") ?? "") ? (sp.get("group") as string).toLowerCase() : undefined,
  }
}

// Explicit admin list columns; never select idempotency_key.
export const ADMIN_ORDER_COLUMNS_BASE =
  "id, reference_code, user_id, channel, network, service_key, beneficiary_phone, bundle_value, bundle_display, bundle_category, amount, paid_amount, status, payment_status, hubtel_client_reference, commission, failure_reason, notes, created_at, updated_at, shop_id, buyer_name, buyer_phone, buyer_email, payment_fee_amount, bot_surface"
/** Plus the Special Bundles group columns (migration 0141). */
export const ADMIN_ORDER_COLUMNS = `${ADMIN_ORDER_COLUMNS_BASE}, special_group_id, special_index`

/**
 * Run the admin page query with the Special columns. Before 0141 is applied (SQLSTATE 42703, undefined column):
 * with a group filter no group can exist, so null (= an empty page); otherwise retry once with the base columns.
 * Any other error is returned unchanged for the caller to throw.
 */
export async function selectOrdersPage<R extends { error: unknown }>(run: (cols: string) => PromiseLike<R>, f: OrderFilters): Promise<R | null> {
  const res = await run(ADMIN_ORDER_COLUMNS)
  if ((res.error as { code?: string } | null)?.code !== "42703") return res
  if (f.group) return null
  return run(ADMIN_ORDER_COLUMNS_BASE)
}

/** "Special 2/3" for a Special child (N = the group's child count; "Special 2" when unknown), else null. */
export function specialBadgeLabel(o: { special_group_id?: string | null; special_index?: number | null }, size: number | undefined): string | null {
  if (!o.special_group_id || !o.special_index) return null
  return size ? `Special ${o.special_index}/${size}` : `Special ${o.special_index}`
}

/**
 * Child count per Special group on an admin page: one head count per distinct group (a page holds at most 100 rows,
 * so at most 100 small indexed counts). A failed count is left out, so its badge shows "Special i" without N.
 */
export async function fetchSpecialGroupSizes(db: SupabaseClient, groupIds: (string | null | undefined)[]): Promise<Map<string, number>> {
  const ids = [...new Set(groupIds.filter((g): g is string => !!g))]
  const out = new Map<string, number>()
  await Promise.all(ids.map(async g => {
    try {
      const { count, error } = await db.from(DATA_ORDERS_TABLE).select("id", { count: "exact", head: true }).eq("special_group_id", g)
      if (!error && typeof count === "number") out.set(g, count)
    } catch { /* left out: badge shows i only */ }
  }))
  return out
}

export function applyOrderFilters<T>(query: T, f: OrderFilters, qAlt?: string): T {
  let q: any = query
  if (f.status) q = q.eq("status", f.status)
  if (f.network) q = q.eq("network", f.network)
  if (f.channel) q = q.eq("channel", f.channel)
  if (f.group) q = q.eq("special_group_id", f.group)
  if (f.from) q = q.gte("created_at", `${f.from}T00:00:00.000Z`)
  if (f.to) q = q.lte("created_at", `${f.to}T23:59:59.999Z`)
  if (f.q) {
    const t = f.q
    const parts = [`reference_code.ilike.%${t}%`, `hubtel_client_reference.ilike.%${t}%`, `beneficiary_phone.ilike.%${t}%`]
    if (qAlt) parts.push(`beneficiary_phone.eq.${qAlt}`)
    q = q.or(parts.join(","))
  }
  return q as T
}

export interface RefundFacts { status: string; payment_status: string; hubtel_client_reference: string | null; notes: string | null; updated_at: string }
export type BundleRefundDecision =
  | { action: "blocked"; reason: string; reviewQueue?: boolean }
  | { action: "direct"; releaseStuck: boolean }

/** processing + paid + no ref + a "Dispatching" note older than 5 minutes (the caller separately proves there is no ledger row). */
export function isStuckClaim(o: RefundFacts, now: number = Date.now()): boolean {
  return o.status === "processing" && o.payment_status === "paid" && !o.hubtel_client_reference &&
    (o.notes ?? "").startsWith("Dispatching") && now - Date.parse(o.updated_at) >= STUCK_CLAIM_MS
}

/**
 * Admin refund decision. Only orders that NEVER reached Hubtel (no ledger row at all) are refunded here;
 * anything with a ledger row belongs to the Hubtel review queue (adapter refundToWallet).
 */
export function bundleRefundDecision(o: RefundFacts, ledgerRows: number, now: number = Date.now()): BundleRefundDecision {
  const blocked = (reason: string, reviewQueue = false): BundleRefundDecision => ({ action: "blocked", reason, ...(reviewQueue ? { reviewQueue } : {}) })
  if (o.status === "refunded" || o.payment_status === "refunded") return blocked("Already refunded")
  if (o.status === "completed") return blocked("Completed orders cannot be refunded")
  if (o.payment_status !== "paid") return blocked("This order was never paid")
  if (ledgerRows > 0) return blocked("This order reached Hubtel. Handle it in the Hubtel review queue.", true)
  if (o.hubtel_client_reference) return blocked("This order has a Hubtel reference but no ledger row; check Hubtel Commission before refunding", true)
  if (isStuckClaim(o, now)) return { action: "direct", releaseStuck: true }
  if (o.status === "processing") {
    return blocked((o.notes ?? "").startsWith("Dispatching")
      ? "A dispatch is in progress; if it never finishes it can be released after 5 minutes"
      : "Still processing; use Sync first")
  }
  if (o.status === "failed") return { action: "direct", releaseStuck: false }
  if (o.status === "pending") {
    if (!(now - Date.parse(o.updated_at) >= UNSENT_GRACE_MS)) return blocked("This order was updated moments ago and may still be dispatching; try again in a minute")
    return { action: "direct", releaseStuck: false }
  }
  return blocked("This order cannot be refunded")
}

/** Order ids (of the given ones) that have any Hubtel ledger row. Throws on DB error: callers must fail closed. */
export async function fetchLedgerOrderIds(db: SupabaseClient, orderIds: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  if (orderIds.length === 0) return out
  const { data, error } = await db.from("hubtel_cs_transactions").select("order_id")
    .eq("order_table", DATA_ORDERS_TABLE).in("order_id", orderIds.slice(0, 200))
  if (error) throw error
  for (const r of (data ?? []) as any[]) out.add(r.order_id)
  return out
}

/** Ledger rows per standard bundle order (newest first). Throws on DB error: callers must fail closed. */
export async function fetchBundleLedgerByOrders(db: SupabaseClient, orderIds: string[]): Promise<Map<string, LedgerFact[]>> {
  const out = new Map<string, LedgerFact[]>()
  if (orderIds.length === 0) return out
  const { data, error } = await db.from("hubtel_cs_transactions")
    .select("order_id, client_reference, state, refund_claimed_at, resolved_by, created_at")
    .eq("order_table", DATA_ORDERS_TABLE).in("order_id", orderIds.slice(0, 200)).order("created_at", { ascending: false })
  if (error) throw error
  for (const r of (data ?? []) as any[]) {
    const list = out.get(r.order_id) ?? []
    list.push({ client_reference: r.client_reference, state: r.state, refund_claimed_at: r.refund_claimed_at, resolved_by: r.resolved_by, created_at: r.created_at })
    out.set(r.order_id, list)
  }
  return out
}

/**
 * Whether an admin may dispatch this order: paid, never sent (no Hubtel reference, NO ledger row of any state), and either
 * pending past the grace window (it may be mid-dispatch before that) or a stuck dispatch claim. Orders with failed ledger
 * rows belong to Retry; any other ledger row belongs to the Hubtel review queue.
 */
export const bundleCanDispatch = (o: RefundFacts, ledgerRows: number, now: number = Date.now()): boolean =>
  ledgerRows === 0 && o.payment_status === "paid" && !o.hubtel_client_reference &&
  (isStuckClaim(o, now) || (o.status === "pending" && now - Date.parse(o.updated_at) >= UNSENT_GRACE_MS))

/** Whether an admin may retry this order: paid, failed, and every Hubtel attempt failed by Hubtel itself (see retryDecision). */
export const bundleCanRetry = (o: { status: string; payment_status: string }, ledger: LedgerFact[]): boolean =>
  o.status === "failed" && o.payment_status === "paid" && retryDecision(o, ledger).ok

/**
 * Release a stuck dispatch claim (processing -> pending), fully guarded in SQL so a stale request can never
 * release another admin's fresh live claim. Returns rows changed (0 => the claim is no longer stuck).
 */
export async function releaseStuckClaimRow(db: SupabaseClient, orderId: string, adminId: string, now: number = Date.now()): Promise<number> {
  const { data, error } = await db.from(DATA_ORDERS_TABLE)
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

// ---------------------------------------------------------------------------------------------
// Never-sent refund flow (all IO injected)
// ---------------------------------------------------------------------------------------------

export interface RefundOrder extends RefundFacts {
  id: string; reference_code: string; user_id: string; amount: number; paid_amount?: number | null; network: string; bundle_display: string; beneficiary_phone: string
  /** 'storefront' rows are refunded on /admin/refunds (the buyer has no wallet). Absent = not selected (legacy caller). */
  channel?: string | null
}

export const STOREFRONT_BUNDLE_REFUND_MESSAGE =
  "Storefront or bot order: the buyer has no wallet. Refund it on /admin/refunds (Paystack reversal, MoMo payout, or Mark refunded manually)."

/** The money to return to the customer: what they paid, falling back to the face amount on legacy rows. */
export const refundAmountOf = (o: Pick<RefundOrder, "amount" | "paid_amount">) => Number(o.paid_amount ?? o.amount)

/** Customer-facing refund notification text (prints the amount actually paid). */
export const refundMessageOf = (o: RefundOrder) =>
  `GHS ${refundAmountOf(o).toFixed(2)} for your ${o.network} ${o.bundle_display} bundle to ${o.beneficiary_phone} was refunded to your wallet.`

export interface BundleRefundDeps {
  getOrder(id: string): Promise<RefundOrder | null>
  /** Number of Hubtel ledger rows for the order. Throws on DB error. */
  ledgerCount(orderId: string): Promise<number>
  /** Guarded processing -> pending (stuck claim); returns rows changed. */
  releaseStuckClaim(orderId: string): Promise<number>
  /** Guarded pending+paid -> failed; this fences the dispatcher out. Returns rows changed. */
  claimForRefund(orderId: string, note: string): Promise<number>
  /** Guarded failed -> processing, used when a ledger row appeared mid-refund. Returns rows changed. */
  revertToProcessing(orderId: string, ref: string | null): Promise<number>
  /** Client reference of the newest ledger row for the order (null if none). */
  ledgerRef(orderId: string): Promise<string | null>
  /** Best-effort customer in-app notification + push after a successful refund. */
  notifyRefunded(order: RefundOrder): Promise<void>
  /** Idempotent credit (reference `data-refund-<id>`, shared with the adapter). Throws on error. */
  creditWallet(order: RefundOrder): Promise<void>
  /** Guarded failed+paid -> refunded/refunded; returns rows changed. */
  markRefunded(orderId: string): Promise<number>
  alert(message: string, urgent?: boolean): Promise<void>
  now(): number
}

export interface BundleRefundResult { ok: boolean; status: number; message: string; released?: boolean }

const safe = async (d: BundleRefundDeps, m: string, urgent = false) => { try { await d.alert(m, urgent) } catch { /* never break the flow */ } }

export async function executeBundleRefund(d: BundleRefundDeps, orderId: string, note: string): Promise<BundleRefundResult> {
  const order = await d.getOrder(orderId)
  if (!order) return { ok: false, status: 404, message: "Order not found" }
  // Checked before anything moves: never fence a storefront order to failed for a wallet refund that cannot happen.
  if (order.channel === "storefront" || order.channel === "bots" || !order.user_id) return { ok: false, status: 409, message: STOREFRONT_BUNDLE_REFUND_MESSAGE }
  let rows: number
  try { rows = await d.ledgerCount(orderId) } catch { return { ok: false, status: 503, message: "Could not read the Hubtel ledger; try again" } }
  const decision = bundleRefundDecision(order, rows, d.now())
  if (decision.action === "blocked") return { ok: false, status: 409, message: decision.reason }

  let released = false
  if (decision.releaseStuck) {
    if ((await d.releaseStuckClaim(orderId)) === 0) return { ok: false, status: 409, message: "Claim is no longer stuck" }
    released = true
  }
  // Fence the dispatcher: pending -> failed (guarded), then prove no ledger row appeared meanwhile.
  // A failed order (already fenced) skips straight to the re-check.
  if (order.status !== "failed") {
    const n = await d.claimForRefund(orderId, `Admin refund: never sent to Hubtel. ${note}`)
    if (n === 0) return { ok: false, status: 409, message: "The order changed while refunding; reload and retry", released }
  }
  const after = await d.ledgerCount(orderId).catch(() => null)
  if (after === null) {
    // Cannot confirm either way: leave the order fenced in `failed` (no dispatcher can claim it); a retry re-checks the ledger.
    await safe(d, `URGENT: standard bundle order ${order.reference_code} (${orderId}) was fenced for an admin refund but the Hubtel ledger could not be re-read. It is left in failed (paid). Retry the refund.`, true)
    return { ok: false, status: 503, message: "Could not confirm the Hubtel ledger - retry. The order is held safely in failed.", released }
  }
  if (after > 0) {
    const ref = await d.ledgerRef(orderId).catch(() => null)
    let reverted = 0
    try { reverted = await d.revertToProcessing(orderId, ref) } catch { reverted = 0 }
    if (reverted === 0) {
      await safe(d, `URGENT: standard bundle order ${order.reference_code} (${orderId}) was moved for a refund, a Hubtel transaction appeared, and the order could NOT be restored to processing. Fix by hand; do not refund.`, true)
      return { ok: false, status: 500, message: "A Hubtel transaction appeared while refunding and the order could not be restored to processing. Admins were alerted; do not refund.", released }
    }
    await safe(d, `Standard bundle order ${order.reference_code}: a Hubtel transaction appeared while an admin refund was starting. Refund aborted; order restored to processing.`)
    return { ok: false, status: 409, message: "A Hubtel transaction appeared for this order while refunding. The refund was aborted; check Hubtel Commission.", released }
  }
  const fresh = await d.getOrder(orderId)
  if (!fresh) return { ok: false, status: 404, message: "Order not found" }
  try {
    await d.creditWallet(fresh)
  } catch (e: any) {
    return { ok: false, status: 502, message: `Refund outcome UNKNOWN (${e?.message ?? e}). Check the customer's wallet before any retry; the credit is idempotent, so retrying is safe.`, released }
  }
  const n = await d.markRefunded(orderId)
  if (n > 0) { try { await d.notifyRefunded(fresh) } catch { /* best-effort */ } }
  return {
    ok: true, status: 200, released,
    message: n > 0 ? "Refunded to the customer's wallet" : "Refunded to the customer's wallet (order status update was skipped: the order was no longer in the expected state)",
  }
}
