// Hubtel main-code orders paid from the caller's wallet (hubtel_wallet_payments, migration 0159).
//
// The payment row is the proof of who paid: only pay_hubtel_order_from_wallet inserts it, in the same transaction as
// the debit, and service_role cannot insert one. A `transactions` debit is weaker proof (/api/wallet/debit takes a
// client-supplied order id), so on these orders the payment row wins.
//
// Refunds: a failed order goes back to that wallet, once (reserve_order_refund's one-active-refund guard plus
// credit_wallet_safely's per-refund reference). Never to a phone: a payout on top of a wallet refund pays twice.
// /admin/refunds can only refund ussd_orders this way today; the other three tables are refused by
// reserve_order_refund (airtime: BAD_CHANNEL; results tables: BAD_TABLE) and keep their own admin pages.
//
// Logs carry ids and amounts only.
import type { SupabaseClient } from "@supabase/supabase-js"
import { WALLET_SWEEP_MIN_AGE_MS, type WalletTable } from "@/lib/ussd-hubtel/wallet-pay"

const TABLE = "hubtel_wallet_payments"
const CHUNK = 100

export type HubtelWalletState = "debited" | "fulfilled" | "needs_review"

export interface HubtelWalletPaymentFact {
  paymentId: string
  orderTable: WalletTable
  orderId: string
  userId: string
  amount: number
  state: HubtelWalletState
  reviewReason: string | null
  createdAt: string
}

/** Shown for every gateway but the wallet on an order paid from the wallet on the Hubtel main code. */
export const HUBTEL_WALLET_REASON = "Paid from the wallet on the Hubtel main code — refund it to the same wallet only"

/** Shown while the payment is still `debited`: the sweep may still deliver the order. */
export const HUBTEL_WALLET_UNSETTLED_REASON =
  "Wallet debited but the order is not settled yet; the sweep may still deliver it. Do not refund yet: check again in a few minutes."

/** Until 0159 is applied the table does not exist: no wallet payment can exist either. */
export const isMissingTable = (e: { code?: string } | null | undefined) => e?.code === "42P01" || e?.code === "PGRST205"

const round2 = (n: number) => Math.round(n * 100) / 100

function toFact(r: any): HubtelWalletPaymentFact {
  return {
    paymentId: String(r.id),
    orderTable: r.order_table as WalletTable,
    orderId: String(r.order_id),
    userId: String(r.user_id),
    amount: round2(Number(r.amount)),
    state: r.state as HubtelWalletState,
    reviewReason: (r.review_reason as string | null | undefined) ?? null,
    createdAt: String(r.created_at ?? ""),
  }
}

const COLUMNS = "id, order_table, order_id, user_id, amount, state, review_reason, created_at"

const readError = (what: string, error: { message?: string; code?: string }) =>
  new Error(`[REFUND] ${what} failed: ${error.message ?? error.code ?? "unknown"}`)

/**
 * The wallet payment rows for these orders of one table, matched by table and order id. A missing table (0159 not
 * applied) is no rows; any other read error THROWS: an unread payment is never treated as no payment.
 */
export async function loadHubtelWalletPayments(db: SupabaseClient, table: WalletTable, ids: string[]): Promise<HubtelWalletPaymentFact[]> {
  const out: HubtelWalletPaymentFact[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK)
    const { data, error } = await (db.from(TABLE).select(COLUMNS) as any).eq("order_table", table).in("order_id", part)
    if (error) {
      if (isMissingTable(error)) return []
      throw readError(`${TABLE} lookup`, error)
    }
    for (const r of (data ?? []) as any[]) {
      if (r.order_table === table && part.includes(String(r.order_id)) && r.user_id && Number(r.amount) > 0) out.push(toFact(r))
    }
  }
  return out
}

/** Order status column per wallet table. */
const STATUS_COLUMN: Record<WalletTable, string> = {
  ussd_orders: "order_status",
  airtime_orders: "status",
  results_checker_orders: "status",
  results_check_requests: "status",
}
/** payment_status of an order its own handler marked paid. */
const PAID_STATUS: Record<WalletTable, string> = {
  ussd_orders: "completed",
  airtime_orders: "completed",
  results_checker_orders: "completed",
  results_check_requests: "paid",
}
/** Delivered, or refunded through the refund ledger. Anything else (failed included) stays listed. */
const RESOLVED = new Set(["completed", "refunded"])

/**
 * order_status values of a PAID ussd_orders row nobody will deliver and /admin/refunds will not refund (it takes
 * pending only): 'failed' (lib/ussd/fulfill.ts, blacklisted recipient) and 'reversed' (lib/mtn-reversal.ts, a provider
 * flipped completed -> failed; never auto-resent). The sync-mtn-status crons and the MTN provider webhooks write a
 * provider failure as 'pending', which stays refundable on this page.
 */
export const FAILED_USSD_STATUSES = ["failed", "reversed"] as const

interface OrderFacts { status: string; paymentStatus: string | null }

/** Where this order is refunded today, given whether its own handler marked it paid. */
function refundHint(table: WalletTable, facts: OrderFacts | undefined): string {
  const paid = !!facts && facts.paymentStatus === PAID_STATUS[table]
  switch (table) {
    case "ussd_orders":
      return paid
        ? "Refund it to the wallet from Pending orders on this page (listed there while the order is pending), or deliver it by hand."
        : "The order was never marked paid, so no refund tool takes it: credit the wallet by hand, or deliver it by hand."
    case "airtime_orders":
      return paid
        ? "Not refundable on this page. Deliver it, or mark it Failed on /admin/airtime: that credits the buyer's wallet."
        : "The order was never marked paid, so /admin/airtime cannot refund it: credit the wallet by hand, or deliver it by hand."
    case "results_checker_orders":
      return paid
        ? "Not refundable on this page. Deliver the vouchers, or use Refund on /admin/results-checker: that credits the buyer's wallet."
        : "The order was never marked paid: Refund on /admin/results-checker is refused for it. Credit the wallet by hand, or deliver by hand."
    case "results_check_requests":
      return "No in-app refund for results check requests. Complete it on /admin/results-check-requests, or credit the wallet by hand."
  }
}

/** Why a row is on the card. */
export type AttentionKind = "needs_review" | "stale_debited" | "failed_order"

export interface HubtelWalletAttentionRow extends HubtelWalletPaymentFact {
  kind: AttentionKind
  /** The order's status now; null when the order could not be found. */
  orderStatus: string | null
  /** The order's payment_status now; null when the order could not be found. */
  orderPaymentStatus: string | null
  /** Why it is listed. */
  reason: string
  /** What the admin can do about it. */
  refundHint: string
}

export interface HubtelWalletAttention {
  rows: HubtelWalletAttentionRow[]
  /** More rows exist than were read: the card says so, so nothing is silently cut off. */
  truncated: boolean
}

/** Rows per page, the most rows shown per kind, and the most pages read per kind. */
export const ATTENTION_PAGE = 200
export const ATTENTION_LIMIT = 200
export const ATTENTION_MAX_PAGES = 10

async function loadOrderFacts(db: SupabaseClient, payments: HubtelWalletPaymentFact[]): Promise<Map<string, OrderFacts>> {
  const out = new Map<string, OrderFacts>()
  for (const table of Object.keys(STATUS_COLUMN) as WalletTable[]) {
    const ids = [...new Set(payments.filter((p) => p.orderTable === table).map((p) => p.orderId))]
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK)
      const { data, error } = await (db.from(table).select(`id, ${STATUS_COLUMN[table]}, payment_status`) as any).in("id", part)
      if (error) throw readError(`${table} status lookup`, error)
      for (const r of (data ?? []) as any[]) {
        if (!part.includes(String(r.id))) continue
        out.set(`${table}:${r.id}`, { status: String(r[STATUS_COLUMN[table]] ?? ""), paymentStatus: r.payment_status == null ? null : String(r.payment_status) })
      }
    }
  }
  return out
}

const key = (p: { orderTable: string; orderId: string }) => `${p.orderTable}:${p.orderId}`
const ghs = (n: number) => `GHS ${n.toFixed(2)}`

/**
 * needs_review payments whose order is not yet completed or refunded. The payment row never leaves needs_review, and
 * its order lives in one of four tables (no join), so resolved rows are dropped page by page: newest first, until
 * ATTENTION_LIMIT unresolved rows or ATTENTION_MAX_PAGES pages. Null = the table does not exist yet.
 */
async function needsReview(db: SupabaseClient): Promise<{ rows: HubtelWalletAttentionRow[]; truncated: boolean } | null> {
  const rows: HubtelWalletAttentionRow[] = []
  for (let page = 0; page < ATTENTION_MAX_PAGES; page++) {
    const { data, error } = await (db.from(TABLE).select(COLUMNS) as any).eq("state", "needs_review")
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(page * ATTENTION_PAGE, (page + 1) * ATTENTION_PAGE - 1)
    if (error) {
      if (isMissingTable(error)) return null
      throw readError(`${TABLE} attention list`, error)
    }
    const batch = ((data ?? []) as any[]).map(toFact).filter((p) => p.state === "needs_review" && p.orderTable in STATUS_COLUMN)
    const facts = await loadOrderFacts(db, batch)
    for (const p of batch) {
      const f = facts.get(key(p))
      if (f && RESOLVED.has(f.status)) continue
      rows.push({
        ...p, kind: "needs_review", orderStatus: f?.status ?? null, orderPaymentStatus: f?.paymentStatus ?? null,
        reason: `Wallet debited ${ghs(p.amount)}, but the order was not completed${p.reviewReason ? ` (${p.reviewReason})` : ""}.`,
        refundHint: refundHint(p.orderTable, f),
      })
      if (rows.length > ATTENTION_LIMIT) return { rows: rows.slice(0, ATTENTION_LIMIT), truncated: true }
    }
    if ((data ?? []).length < ATTENTION_PAGE) return { rows, truncated: false }
  }
  return { rows, truncated: true } // the page bound was reached with full pages: older rows were not read
}

/** Payments still debited after the sweep window (read-only: the sweep may still deliver them). */
async function staleDebited(db: SupabaseClient, now: number): Promise<{ rows: HubtelWalletAttentionRow[]; truncated: boolean } | null> {
  const staleBefore = new Date(now - WALLET_SWEEP_MIN_AGE_MS).toISOString()
  const { data, error } = await (db.from(TABLE).select(COLUMNS) as any).eq("state", "debited").lt("created_at", staleBefore)
    .order("created_at", { ascending: false }).limit(ATTENTION_LIMIT + 1)
  if (error) {
    if (isMissingTable(error)) return null
    throw readError(`${TABLE} attention list`, error)
  }
  const all = ((data ?? []) as any[]).map(toFact)
    .filter((p) => p.state === "debited" && Date.parse(p.createdAt) < Date.parse(staleBefore) && p.orderTable in STATUS_COLUMN)
  const batch = all.slice(0, ATTENTION_LIMIT)
  const facts = await loadOrderFacts(db, batch)
  return {
    truncated: all.length > ATTENTION_LIMIT,
    rows: batch.map((p) => {
      const f = facts.get(key(p))
      return {
        ...p, kind: "stale_debited" as const, orderStatus: f?.status ?? null, orderPaymentStatus: f?.paymentStatus ?? null,
        reason: `Wallet debited ${ghs(p.amount)} over 10 minutes ago and the sweep has not settled it yet.`,
        refundHint: `Do not refund yet: the sweep may still deliver it. If it stays here, check the status-check cron. ${refundHint(p.orderTable, f)}`,
      }
    }),
  }
}

/**
 * Wallet-paid (fulfilled) ussd_orders that are paid but failed or reversed: /admin/refunds takes pending orders only,
 * so these have no refund tool. Read from the order side (failed + paid, newest first, since the first ussd_orders
 * wallet payment less an hour), then matched to their fulfilled payments; paged, with the same bounds.
 */
async function failedUssdOrders(db: SupabaseClient): Promise<{ rows: HubtelWalletAttentionRow[]; truncated: boolean } | null> {
  const { data: first, error: firstErr } = await (db.from(TABLE).select("created_at") as any).eq("order_table", "ussd_orders")
    .order("created_at", { ascending: true }).limit(1)
  if (firstErr) {
    if (isMissingTable(firstErr)) return null
    throw readError(`${TABLE} attention list`, firstErr)
  }
  const firstAt = Date.parse(String((first ?? [])[0]?.created_at ?? ""))
  if (!Number.isFinite(firstAt)) return { rows: [], truncated: false }
  const since = new Date(firstAt - 3_600_000).toISOString()

  const rows: HubtelWalletAttentionRow[] = []
  for (let page = 0; page < ATTENTION_MAX_PAGES; page++) {
    const { data, error } = await (db.from("ussd_orders").select("id, order_status, payment_status, created_at") as any)
      .in("order_status", [...FAILED_USSD_STATUSES]).eq("payment_status", "completed").gte("created_at", since)
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(page * ATTENTION_PAGE, (page + 1) * ATTENTION_PAGE - 1)
    if (error) throw readError("ussd_orders failed-order list", error)
    const orders = ((data ?? []) as any[]).filter((o) =>
      (FAILED_USSD_STATUSES as readonly string[]).includes(String(o.order_status)) && o.payment_status === "completed")
    const byId = new Map(orders.map((o) => [String(o.id), o]))
    const payments = (await loadHubtelWalletPayments(db, "ussd_orders", [...byId.keys()])).filter((p) => p.state === "fulfilled")
    for (const p of payments) {
      const o = byId.get(p.orderId)!
      rows.push({
        ...p, kind: "failed_order", orderStatus: String(o.order_status), orderPaymentStatus: String(o.payment_status),
        reason: `Wallet debited ${ghs(p.amount)} and the order is ${String(o.order_status)}: nothing will deliver it, and this page only refunds pending orders.`,
        refundHint: "Refund by hand from the wallet; check it wasn't resent first.",
      })
      if (rows.length > ATTENTION_LIMIT) return { rows: rows.slice(0, ATTENTION_LIMIT), truncated: true }
    }
    if ((data ?? []).length < ATTENTION_PAGE) return { rows, truncated: false }
  }
  return { rows, truncated: true }
}

/**
 * Wallet money an admin must see, whatever happened to the SMS alert: `needs_review` payments until their order is
 * completed or refunded; payments still `debited` once the sweep should have settled them (read-only); and fulfilled
 * payments on ussd_orders that failed or were reversed. Newest first. `truncated` when any list hit its bound.
 * Throws on a read error; a missing table (0159 not applied) is an empty list.
 */
export async function listHubtelWalletAttention(db: SupabaseClient, now: number = Date.now()): Promise<HubtelWalletAttention> {
  const review = await needsReview(db)
  if (review === null) return { rows: [], truncated: false }
  const debited = await staleDebited(db, now)
  const failed = await failedUssdOrders(db)
  const parts = [review, debited ?? { rows: [], truncated: false }, failed ?? { rows: [], truncated: false }]
  const seen = new Set<string>()
  const rows = parts.flatMap((p) => p.rows).filter((r) => !seen.has(r.paymentId) && !!seen.add(r.paymentId))
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  return { rows, truncated: parts.some((p) => p.truncated) }
}
