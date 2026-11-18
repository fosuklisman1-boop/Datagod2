import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { roleBasePrices } from "@/lib/roles/pricing"
import { RoleReadError } from "@/lib/roles/repo"

export const dynamic = "force-dynamic"

/**
 * The signed-in user's BASE price for every available package as a shop owner (admin priced as a dealer; custom
 * prices never apply). Display only: the shop order routes re-price. The owner-side pages add their margin to it.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (!auth?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
  const { data: authData, error: authErr } = await db.auth.getUser(auth.slice(7))
  if (authErr || !authData?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: user, error: userErr } = await db.from("users").select("role").eq("id", authData.user.id).maybeSingle()
  if (userErr) return NextResponse.json({ error: "Failed to load prices" }, { status: 503 })
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })
  const { data: pkgs, error } = await db.from("packages").select("id, price, dealer_price").eq("is_available", true)
  if (error) return NextResponse.json({ error: "Failed to load prices" }, { status: 500 })

  let base: Map<string, number>
  try {
    base = await roleBasePrices(db, user.role, pkgs ?? [], { admin: "as_dealer" })
  } catch (e) {
    if (!(e instanceof RoleReadError)) throw e
    console.error("[owner-base-prices] role prices unavailable:", e.name)
    return NextResponse.json({ error: "Failed to load prices" }, { status: 503 })
  }
  return NextResponse.json({ base: Object.fromEntries(base) }, { headers: { "Cache-Control": "no-store" } })
}
