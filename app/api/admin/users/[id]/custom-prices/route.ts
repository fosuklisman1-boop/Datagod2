import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { rolePrice } from "@/lib/pricing/package-price"
import { parseCustomPricesBody, isUuid } from "@/lib/pricing/custom-prices-input"

export const dynamic = "force-dynamic"

const supabase = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
type Ctx = { params: Promise<{ id: string }> }

/** A user's pricing mode and every available data package with their custom price (admin only). */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin || errorResponse) return errorResponse ?? NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: "Invalid user id" }, { status: 400 })
  const db = supabase()

  const { data: user, error: userErr } = await db.from("users").select("id, role, pricing_mode").eq("id", id).maybeSingle()
  if (userErr) return NextResponse.json({ error: "Failed to load user" }, { status: 500 })
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })

  const prices = await db.from("user_package_prices").select("package_id, price").eq("user_id", id)
  if (prices.error) return NextResponse.json({ error: "Failed to load prices" }, { status: 500 })
  const custom = new Map((prices.data ?? []).map((r: any) => [String(r.package_id), Number(r.price)]))

  // Available packages, plus any package the user still has a custom price for even if it is now
  // unavailable, so an admin can see and clear it (it would apply again if the package were re-enabled).
  const cols = "id, network, size, price, dealer_price, is_available"
  const [avail, stale] = await Promise.all([
    db.from("packages").select(cols).eq("is_available", true).order("network").order("size"),
    custom.size
      ? db.from("packages").select(cols).in("id", [...custom.keys()]).eq("is_available", false).order("network").order("size")
      : Promise.resolve({ data: [] as any[], error: null }),
  ])
  if (avail.error || stale.error) return NextResponse.json({ error: "Failed to load prices" }, { status: 500 })

  // role_price follows the direct charge-point rule (role === "dealer"). Shop code counts admins as dealers too.
  const isDealer = user.role === "dealer"
  return NextResponse.json({
    user: { id: user.id, role: user.role, pricing_mode: user.pricing_mode ?? "role" },
    packages: [...(avail.data ?? []), ...(stale.data ?? [])].map((p: any) => ({
      id: p.id,
      network: p.network,
      size: p.size,
      price: Number(p.price),
      dealer_price: p.dealer_price == null ? null : Number(p.dealer_price),
      role_price: rolePrice(p, isDealer),
      custom_price: custom.get(String(p.id)) ?? null,
      is_available: p.is_available !== false,
    })),
  })
}

/** Set the pricing mode and/or custom prices in one transaction (set_user_custom_prices RPC, audited). */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin || errorResponse) return errorResponse ?? NextResponse.json({ error: "Forbidden" }, { status: 403 })
  // The CRON_SECRET bypass has no userId; every change needs a real admin for the audit log.
  if (!adminId) return NextResponse.json({ error: "Admin session required" }, { status: 403 })
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: "Invalid user id" }, { status: 400 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const parsed = parseCustomPricesBody(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, errors: parsed.errors }, { status: 400 })

  const { data, error } = await supabase().rpc("set_user_custom_prices", {
    p_admin: adminId,
    p_user: id,
    p_mode: parsed.value.pricing_mode,
    p_prices: parsed.value.prices,
  })
  if (error) {
    if ((error as any).code === "P0001" && error.message === "BAD_INPUT") {
      const detail = (error as any).details || "Invalid input"
      return NextResponse.json({ error: detail }, { status: detail === "user not found" ? 404 : 400 })
    }
    console.error("[CUSTOM-PRICES] save failed:", error.message)
    return NextResponse.json({ error: "Failed to save prices" }, { status: 500 })
  }
  return NextResponse.json({ success: true, changed: (data as any)?.changed ?? 0 })
}
