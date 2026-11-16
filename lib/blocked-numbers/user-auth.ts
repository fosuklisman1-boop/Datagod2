import { supabaseAdmin } from "@/lib/supabase"

/** Session user id from a Bearer token, or null. */
export async function authUserId(request: Request): Promise<string | null> {
  const h = request.headers.get("authorization")
  if (!h?.startsWith("Bearer ")) return null
  const { data, error } = await supabaseAdmin.auth.getUser(h.slice(7))
  if (error || !data?.user) return null
  return data.user.id
}

/** Shops the session user owns. Never takes a shop id from the client. */
export async function ownedShopIds(userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from("user_shops").select("id").eq("user_id", userId)
  if (error) throw new Error("shops read failed")
  return ((data ?? []) as Array<{ id: string }>).map((s) => s.id)
}
