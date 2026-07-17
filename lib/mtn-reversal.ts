import type { SupabaseClient } from "@supabase/supabase-js"
import { notifyAdminsPush } from "@/lib/push-service"

export const REVERSAL_WINDOW_MS = 72 * 60 * 60 * 1000

export type ReversalRow = {
  id: string
  order_type: string | null
  order_id: string | null
  shop_order_id: string | null
  api_order_id: string | null
  provider: string | null
}

/** A completed tracking row whose provider now reports failed, still inside the 72h window. */
export function isReversal(args: {
  trackingStatus: string
  completedAt: string | Date
  providerStatus: string
  now?: Date
}): boolean {
  if (args.trackingStatus !== "completed") return false
  if (args.providerStatus !== "failed") return false
  const now = args.now ?? new Date()
  const completed = new Date(args.completedAt).getTime()
  return now.getTime() - completed <= REVERSAL_WINDOW_MS
}

function orderTarget(row: ReversalRow): { table: string; col: "status" | "order_status"; id: string } | null {
  if (row.order_type === "bulk" && row.order_id) return { table: "orders", col: "status", id: row.order_id }
  if (row.order_type === "api" && (row.api_order_id || row.order_id)) return { table: "api_orders", col: "status", id: (row.api_order_id || row.order_id)! }
  if (row.order_type === "ussd" && row.order_id) return { table: "ussd_orders", col: "order_status", id: row.order_id }
  if (row.order_type === "ussd_shop" && row.order_id) return { table: "ussd_shop_orders", col: "order_status", id: row.order_id }
  if (row.shop_order_id) return { table: "shop_orders", col: "order_status", id: row.shop_order_id }
  // Legacy rows without order_type — mirror the existing fulfillment dispatch fallback
  // (order_id → assume bulk; api_order_id → api) so the order can't be left stranded.
  if (row.order_id) return { table: "orders", col: "status", id: row.order_id }
  if (row.api_order_id) return { table: "api_orders", col: "status", id: row.api_order_id }
  return null
}

/** Flag a provider reversal: tracking + order -> 'reversed', notify admins. */
export async function flagReversal(
  supabase: SupabaseClient,
  row: ReversalRow,
  provider: { status?: string; message?: string },
): Promise<{ flagged: boolean }> {
  const nowIso = new Date().toISOString()

  await supabase
    .from("mtn_fulfillment_tracking")
    .update({ status: "reversed", external_status: provider.status ?? "failed", external_message: provider.message ?? null, updated_at: nowIso })
    .eq("id", row.id)

  const target = orderTarget(row)
  if (target) {
    await supabase.from(target.table).update({ [target.col]: "reversed", updated_at: nowIso }).eq("id", target.id)
  }

  const ref = row.shop_order_id || row.order_id || row.api_order_id || row.id
  notifyAdminsPush({
    title: "⚠️ Provider reversed a completed order",
    body: `${row.provider ?? "provider"} flipped order #${String(ref).slice(0, 8)} completed→failed — flagged for review`,
    data: { url: "/admin/orders" },
  }).catch(() => {})

  return { flagged: true }
}

/** Load completed tracking rows for a provider still inside the 72h reversal window. */
export async function fetchReversalCandidates(supabase: SupabaseClient, provider: string, limit = 200): Promise<ReversalRow[]> {
  const since = new Date(Date.now() - REVERSAL_WINDOW_MS).toISOString()
  const { data } = await supabase
    .from("mtn_fulfillment_tracking")
    .select("id, mtn_order_id, order_type, order_id, shop_order_id, api_order_id, provider, status, updated_at")
    .eq("provider", provider)
    .eq("status", "completed")
    .gte("updated_at", since)
    .not("mtn_order_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(limit)
  return (data as any[]) ?? []
}
