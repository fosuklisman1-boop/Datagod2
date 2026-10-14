import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { loadAvailability, resolveShop } from "@/lib/storefront-commission/shop"
import { getAvailabilityRuntime } from "@/lib/storefront-commission/runtime"

export const dynamic = "force-dynamic"

/** Public: GET ?shop=<handle> — which commission products this storefront may sell right now. */
export async function GET(request: NextRequest) {
  try {
    const rl = await applyRateLimit(request, "shop_commission_availability", 60, 60_000)
    if (!rl.allowed) return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 })
    const { deps, db } = getAvailabilityRuntime()
    const shop = await resolveShop(db, new URL(request.url).searchParams.get("shop"))
    if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    return NextResponse.json(await loadAvailability(deps))
  } catch (e) {
    console.error("[shop-commission] availability error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
