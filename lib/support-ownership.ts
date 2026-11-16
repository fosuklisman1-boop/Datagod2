import type { SupabaseClient } from "@supabase/supabase-js"
import type { OrderTiming } from "@/lib/support-eligibility"

/** The caller's own order with what the complaint-window rule needs, or null. Throws on a database error. */
export async function ownedOrderTiming(db: SupabaseClient, userId: string, orderId: string): Promise<OrderTiming | null> {
  const { data, error } = await db
    .from("orders")
    .select("id, status, created_at, updated_at")
    .eq("id", orderId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error("order ownership lookup failed")
  if (!data) return null
  return { status: data.status ?? null, createdAt: data.created_at ?? null, updatedAt: data.updated_at ?? null }
}

/** A shop order from a shop the caller owns, with its timing, or null. Throws on a database error. */
export async function ownedShopOrderTiming(db: SupabaseClient, userId: string, shopOrderId: string): Promise<OrderTiming | null> {
  const { data: order, error } = await db
    .from("shop_orders")
    .select("shop_id, order_status, created_at, updated_at")
    .eq("id", shopOrderId)
    .maybeSingle()
  if (error) throw new Error("shop order lookup failed")
  if (!order?.shop_id) return null
  const { data: shop, error: shopError } = await db
    .from("user_shops")
    .select("id")
    .eq("id", order.shop_id)
    .eq("user_id", userId)
    .maybeSingle()
  if (shopError) throw new Error("shop ownership lookup failed")
  if (!shop) return null
  return { status: order.order_status ?? null, createdAt: order.created_at ?? null, updatedAt: order.updated_at ?? null }
}

/** True only when the order exists AND belongs to the caller. Throws on a database error. */
export async function callerOwnsOrder(db: SupabaseClient, userId: string, orderId: string): Promise<boolean> {
  return (await ownedOrderTiming(db, userId, orderId)) !== null
}

/** True only when the shop order belongs to a shop the caller owns. Throws on a database error. */
export async function callerOwnsShopOrder(db: SupabaseClient, userId: string, shopOrderId: string): Promise<boolean> {
  return (await ownedShopOrderTiming(db, userId, shopOrderId)) !== null
}
