import type { SupabaseClient } from "@supabase/supabase-js"

/** True only when the order exists AND belongs to the caller. Throws on a database error. */
export async function callerOwnsOrder(db: SupabaseClient, userId: string, orderId: string): Promise<boolean> {
  const { data, error } = await db.from("orders").select("id").eq("id", orderId).eq("user_id", userId).maybeSingle()
  if (error) throw new Error("order ownership lookup failed")
  return !!data
}

/** True only when the shop order belongs to a shop the caller owns. Throws on a database error. */
export async function callerOwnsShopOrder(db: SupabaseClient, userId: string, shopOrderId: string): Promise<boolean> {
  const { data: order, error } = await db.from("shop_orders").select("shop_id").eq("id", shopOrderId).maybeSingle()
  if (error) throw new Error("shop order lookup failed")
  if (!order?.shop_id) return false
  const { data: shop, error: shopError } = await db
    .from("user_shops")
    .select("id")
    .eq("id", order.shop_id)
    .eq("user_id", userId)
    .maybeSingle()
  if (shopError) throw new Error("shop ownership lookup failed")
  return !!shop
}
