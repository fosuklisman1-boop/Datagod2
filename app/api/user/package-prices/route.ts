import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { customPricesForUser, effectivePrice } from "@/lib/pricing/package-price"

export const dynamic = "force-dynamic"

/** The signed-in user's price for every available data package (display only; order routes re-price). */
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
  const userId = authData.user.id

  const { data: user, error: userErr } = await db.from("users").select("role, pricing_mode").eq("id", userId).maybeSingle()
  if (userErr) return NextResponse.json({ error: "Failed to load prices" }, { status: 503 })
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })
  const { data: pkgs, error } = await db.from("packages").select("id, price, dealer_price").eq("is_available", true)
  if (error) return NextResponse.json({ error: "Failed to load prices" }, { status: 500 })

  let custom
  try {
    custom = await customPricesForUser(db, { id: userId, pricing_mode: user.pricing_mode ?? null })
  } catch {
    return NextResponse.json({ error: "Failed to load prices" }, { status: 503 })
  }
  // Same dealer rule as /api/orders/purchase, the route this page buys through.
  const isDealer = user.role === "dealer"
  const prices = Object.fromEntries((pkgs ?? []).map((p: any) => [p.id, effectivePrice(p, isDealer, custom)]))
  const custom_ids = (pkgs ?? []).map((p: any) => String(p.id)).filter((id: string) => custom.has(id))
  return NextResponse.json({ pricing_mode: user.pricing_mode ?? "role", prices, custom_ids }, { headers: { "Cache-Control": "no-store" } })
}
