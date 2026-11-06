// lib/payments/expire-shop-orders.ts
// Unpaid shop orders past their life are expired so they stop counting against the per-shop pending cap. An order with
// a live Hubtel attempt is skipped: a hosted link stays payable for 60 minutes, longer than an order's 30, and the
// customer may be paying right now. It expires on a later run, once that attempt has closed.
import type { SupabaseClient } from "@supabase/supabase-js"
import { findHubtelAttempts, isLiveHubtelStatus } from "@/lib/hubtel-pay/lookup"

const PAGE = 500
/** A cap on one run; anything left over goes on the next. */
const MAX_PAGES = 10

/** Returns how many orders were expired. A failed lookup expires nothing in that page, and the next run tries again. */
export async function expireStaleShopOrders(db: SupabaseClient, cutoffIso: string): Promise<number> {
  let expired = 0
  let skipped = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await db.from("shop_orders").select("id")
      .eq("payment_status", "pending").lt("created_at", cutoffIso)
      .order("created_at", { ascending: true }).range(skipped, skipped + PAGE - 1)
    if (error) throw new Error(`shop_orders read failed: ${error.message}`)
    const ids = ((data ?? []) as { id: string }[]).map((r) => r.id)
    if (ids.length === 0) break

    const { data: payments, error: wpError } = await db.from("wallet_payments").select("order_id, reference").in("order_id", ids)
    if (wpError) throw new Error(`wallet_payments read failed: ${wpError.message}`)
    const refsByOrder = new Map<string, string[]>()
    for (const p of (payments ?? []) as { order_id: string; reference: string }[]) {
      refsByOrder.set(p.order_id, [...(refsByOrder.get(p.order_id) ?? []), p.reference])
    }

    let attempts: Awaited<ReturnType<typeof findHubtelAttempts>>
    try {
      attempts = await findHubtelAttempts(db, [...ids, ...[...refsByOrder.values()].flat()])
    } catch (e) {
      // Can't tell who may be paying: expire no more this run. Pending orders just wait for the next one.
      console.error("[EXPIRE-STALE] Hubtel attempt lookup failed:", e instanceof Error ? e.message : "unknown error")
      return expired
    }
    const isLive = (ref: string) => (attempts.get(ref) ?? []).some((a) => isLiveHubtelStatus(a.status))
    const toExpire = ids.filter((id) => !isLive(id) && !(refsByOrder.get(id) ?? []).some(isLive))

    if (toExpire.length > 0) {
      // Re-guarded on pending: a payment may have landed since the read above.
      const { data: updated, error: upError } = await db.from("shop_orders")
        .update({ order_status: "expired", payment_status: "expired", updated_at: new Date().toISOString() })
        .in("id", toExpire).eq("payment_status", "pending").select("id")
      if (upError) throw new Error(`shop_orders update failed: ${upError.message}`)
      expired += updated?.length ?? 0
    }
    skipped += ids.length - toExpire.length
    if (ids.length < PAGE) break
  }
  return expired
}
