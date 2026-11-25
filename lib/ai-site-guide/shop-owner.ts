import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * True when the verified user owns at least one shop (user_shops.user_id). One read; fails closed (false) on any
 * error so a lookup problem never widens what the assistant may show.
 */
export async function isShopOwnerFor(db: Pick<SupabaseClient, "from">, userId: string): Promise<boolean> {
  try {
    const { data, error } = await db.from("user_shops").select("id").eq("user_id", userId).limit(1)
    if (error) return false
    return Array.isArray(data) && data.length > 0
  } catch {
    return false
  }
}
