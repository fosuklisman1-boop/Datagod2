import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { NextRequest } from "next/server"

/** The signed-in shop owner's shop id, or null. Same auth as the other /api/dashboard/ussd-shop routes. */
export async function ownerShop(request: NextRequest): Promise<{ db: SupabaseClient; shopId: string } | null> {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) return null
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data: { user } } = await db.auth.getUser(token)
  if (!user) return null
  const { data: shop } = await db.from("user_shops").select("id").eq("user_id", user.id).maybeSingle()
  return shop ? { db, shopId: (shop as { id: string }).id } : null
}
