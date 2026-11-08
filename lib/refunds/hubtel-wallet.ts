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
const LIST_LIMIT = 200

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
const isMissingTable = (e: { code?: string } | null | undefined) => e?.code === "42P01" || e?.code === "PGRST205"

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
      throw new Error(`[REFUND] ${TABLE} lookup failed: ${error.message ?? error.code ?? "unknown"}`)
    }
    for (const r of (data ?? []) as any[]) {
      if (r.order_table === table && part.includes(String(r.order_id)) && r.user_id && Number(r.amount) > 0) out.push(toFact(r))
    }
  }
  return out
}

/** Order status column per wallet table, and the statuses that mean the money is no longer at stake. */
const STATUS_COLUMN: Record<WalletTable, string> = {
  ussd_orders: "order_status",
  airtime_orders: "status",
  results_checker_orders: "status",
  results_check_requests: "status",
}
/** Delivered, or refunded through the refund ledger. Anything else (failed included) stays listed. */
const RESOLVED = new Set(["completed", "refunded"])

/** Where each table's wallet-paid order is refunded today. */
const REFUND_HINT: Record<WalletTable, string> = {
  ussd_orders: "Refund it to the wallet from Pending orders on this page (it is listed there while the order is pending and paid), or deliver it by hand.",
  airtime_orders: "Not refundable on this page. Deliver it, or mark it Failed on /admin/airtime: that credits the buyer's wallet.",
  results_checker_orders: "Not refundable on this page. Deliver the vouchers, or use Refund on /admin/results-checker: that credits the buyer's wallet.",
  results_check_requests: "No in-app refund for results check requests. Complete it on /admin/results-check-requests, or credit the wallet by hand.",
}

export interface HubtelWalletAttentionRow extends HubtelWalletPaymentFact {
  state: "debited" | "needs_review"
  /** The order's status now; null when the order could not be found. */
  orderStatus: string | null
  /** Why it is listed. */
  reason: string
  /** What the admin can do about it. */
  refundHint: string
}

/**
 * Wallet money an admin must see, whatever happened to the SMS alert: every `needs_review` payment (until its order is
 * completed or refunded, since the row itself never leaves that state), and every payment still `debited` once the
 * sweep should have settled it (10 minutes). Debited rows are listed read-only: the sweep may still deliver them.
 * Newest first, at most 200 of each. Throws on a read error (a missing table is an empty list).
 */
export async function listHubtelWalletAttention(db: SupabaseClient, now: number = Date.now()): Promise<HubtelWalletAttentionRow[]> {
  const staleBefore = new Date(now - WALLET_SWEEP_MIN_AGE_MS).toISOString()
  const read = async (q: any): Promise<HubtelWalletPaymentFact[] | null> => {
    const { data, error } = await q.order("created_at", { ascending: false }).limit(LIST_LIMIT)
    if (error) {
      if (isMissingTable(error)) return null
      throw new Error(`[REFUND] ${TABLE} attention list failed: ${error.message ?? error.code ?? "unknown"}`)
    }
    return ((data ?? []) as any[]).map(toFact)
  }
  const review = await read((db.from(TABLE).select(COLUMNS) as any).eq("state", "needs_review"))
  if (review === null) return []
  const debited = await read((db.from(TABLE).select(COLUMNS) as any).eq("state", "debited").lt("created_at", staleBefore))
  if (debited === null) return []

  const seen = new Set<string>()
  const candidates = [
    ...review.filter((p) => p.state === "needs_review"),
    ...debited.filter((p) => p.state === "debited" && Date.parse(p.createdAt) < Date.parse(staleBefore)),
  ].filter((p) => !seen.has(p.paymentId) && !!seen.add(p.paymentId) && p.orderTable in STATUS_COLUMN)

  const statusOf = new Map<string, string>()
  for (const table of Object.keys(STATUS_COLUMN) as WalletTable[]) {
    const ids = [...new Set(candidates.filter((p) => p.orderTable === table).map((p) => p.orderId))]
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK)
      const { data, error } = await (db.from(table).select(`id, ${STATUS_COLUMN[table]}`) as any).in("id", part)
      if (error) throw new Error(`[REFUND] ${table} status lookup failed: ${error.message ?? error.code ?? "unknown"}`)
      for (const r of (data ?? []) as any[]) {
        if (part.includes(String(r.id))) statusOf.set(`${table}:${r.id}`, String(r[STATUS_COLUMN[table]] ?? ""))
      }
    }
  }

  const rows: HubtelWalletAttentionRow[] = []
  for (const p of candidates) {
    const orderStatus = statusOf.get(`${p.orderTable}:${p.orderId}`) ?? null
    if (p.state === "needs_review") {
      if (orderStatus && RESOLVED.has(orderStatus)) continue
      rows.push({
        ...p, state: "needs_review", orderStatus,
        reason: `Wallet debited GHS ${p.amount.toFixed(2)}, but the order was not completed${p.reviewReason ? ` (${p.reviewReason})` : ""}.`,
        refundHint: REFUND_HINT[p.orderTable],
      })
    } else {
      rows.push({
        ...p, state: "debited", orderStatus,
        reason: `Wallet debited GHS ${p.amount.toFixed(2)} over 10 minutes ago and the sweep has not settled it yet.`,
        refundHint: `Do not refund yet: the sweep may still deliver it. If it stays here, check the status-check cron. ${REFUND_HINT[p.orderTable]}`,
      })
    }
  }
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}
