import type { SupabaseClient } from "@supabase/supabase-js"

export interface BulkStatusFilters {
  filter_status?: string
  filter_network?: string
  date_from?: string
  date_to?: string
}

export type BulkStatusIds = Record<"orders" | "shop_orders" | "ussd_orders" | "ussd_shop_orders" | "api_orders", string[]>

/**
 * Resolves the order ids matching the filters across the five order tables. Moved unchanged from the
 * bulk_update_order_status handler in lib/ai-tools.ts. Shop and USSD tables only ever match paid orders
 * (payment_status = completed). Throws on a read error.
 */
export async function resolveBulkStatusIds(db: SupabaseClient, filters: BulkStatusFilters, _status?: string): Promise<BulkStatusIds> {
  const fs = filters.filter_status
  const fn = filters.filter_network
  const df = filters.date_from
  const dt = filters.date_to

  function applyFilters(q: any, statusField: "status" | "order_status", paymentFilter?: string) {
    if (paymentFilter) q = q.eq("payment_status", paymentFilter)
    if (fs) q = q.eq(statusField, fs)
    if (fn) q = q.ilike("network", fn)
    if (df) q = q.gte("created_at", df)
    if (dt) q = q.lte("created_at", dt)
    return q
  }

  const [r1, r2, r3, r4, r5] = await Promise.all([
    applyFilters(db.from("orders").select("id"), "status"),
    applyFilters(db.from("shop_orders").select("id"), "order_status", "completed"),
    applyFilters(db.from("ussd_orders").select("id"), "order_status", "completed"),
    applyFilters(db.from("ussd_shop_orders").select("id"), "order_status", "completed"),
    applyFilters(db.from("api_orders").select("id"), "status"),
  ])

  const err = [r1.error, r2.error, r3.error, r4.error, r5.error].find(Boolean)
  if (err) throw new Error(err.message)

  const ids = (r: { data: { id: string }[] | null }) => (r.data ?? []).map((o) => o.id)
  return {
    orders: ids(r1),
    shop_orders: ids(r2),
    ussd_orders: ids(r3),
    ussd_shop_orders: ids(r4),
    api_orders: ids(r5),
  }
}
