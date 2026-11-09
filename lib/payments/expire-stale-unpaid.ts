// lib/payments/expire-stale-unpaid.ts
// Unpaid airtime and results-checker orders past their life are expired (status and payment_status 'expired'). An order
// with any Hubtel main-code wallet payment (hubtel_wallet_payments, migration 0159) is skipped, however old: the wallet
// RPC debits before the order's own handler marks it paid, so a paid order can still read pending_payment. The sweep
// (debited) or an admin (needs_review) settles it; expiring it would hide a paid order.
// Logs carry the table and counts only.
import type { SupabaseClient } from "@supabase/supabase-js"

export type StaleUnpaidTable = "airtime_orders" | "results_checker_orders"

const UNPAID = "pending_payment"
/** Goes into `.in()` lists: much longer URLs have failed in production (see bulk order chunking). */
const PAGE = 200
/** A cap on one run, to stay inside cron-job.org's 30 s; anything left over goes on the next. */
const MAX_PAGES = 5

/** Until 0159 is applied the table does not exist, and no wallet payment can exist either. */
const isMissingTable = (e: { code?: string } | null | undefined) => e?.code === "42P01" || e?.code === "PGRST205"

/**
 * Returns how many orders were expired. Throws on a read or update error: a page whose wallet payments could not be
 * read expires nothing, and the next run tries again.
 */
export async function expireStaleUnpaidOrders(db: SupabaseClient, table: StaleUnpaidTable, cutoffIso: string): Promise<number> {
  let expired = 0
  let skipped = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await db.from(table).select("id")
      .eq("status", UNPAID).eq("payment_status", UNPAID).lt("created_at", cutoffIso)
      .order("created_at", { ascending: true }).range(skipped, skipped + PAGE - 1)
    if (error) throw new Error(`${table} read failed: ${error.message}`)
    const ids = ((data ?? []) as { id: string }[]).map((r) => r.id)
    if (ids.length === 0) break

    const { data: payments, error: payErr } = await db.from("hubtel_wallet_payments").select("order_id")
      .eq("order_table", table).in("order_id", ids)
    if (payErr && !isMissingTable(payErr)) throw new Error(`hubtel_wallet_payments read failed: ${payErr.message}`)
    const paid = new Set(((payErr ? [] : payments ?? []) as { order_id: string }[]).map((p) => String(p.order_id)))
    const toExpire = ids.filter((id) => !paid.has(id))
    if (toExpire.length < ids.length) console.warn("[EXPIRE-STALE]", table, "left orders with a wallet payment alone:", ids.length - toExpire.length)

    if (toExpire.length > 0) {
      // Re-guarded on unpaid: a payment may have landed since the read above.
      const { data: updated, error: upErr } = await db.from(table)
        .update({ status: "expired", payment_status: "expired", updated_at: new Date().toISOString() })
        .in("id", toExpire).eq("status", UNPAID).eq("payment_status", UNPAID).select("id")
      if (upErr) throw new Error(`${table} update failed: ${upErr.message}`)
      expired += updated?.length ?? 0
    }
    skipped += ids.length - toExpire.length
    if (ids.length < PAGE) break
  }
  return expired
}
