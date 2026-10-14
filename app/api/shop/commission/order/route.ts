import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { getBillsRuntime } from "@/lib/bills/runtime"
import { getStorefrontOrderStatus, isValidOrderRef, resolveShop } from "@/lib/storefront-commission/shop"

export const dynamic = "force-dynamic"

/** Public: GET ?ref=<reference>&shop=<handle> — { status, paymentStatus } of a storefront bill/bundle order, nothing else. */
export async function GET(request: NextRequest) {
  try {
    const rl = await applyRateLimit(request, "shop_commission_order", 60, 60_000)
    if (!rl.allowed) return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 })
    const params = new URL(request.url).searchParams
    const ref = params.get("ref")
    if (!isValidOrderRef(ref)) return NextResponse.json({ error: "Order not found" }, { status: 404 })
    const { db } = getBillsRuntime()
    const shop = await resolveShop(db, params.get("shop"))
    if (!shop) return NextResponse.json({ error: "Order not found" }, { status: 404 })
    const s = await getStorefrontOrderStatus(db, shop.id, ref)
    if (!s) return NextResponse.json({ error: "Order not found" }, { status: 404 })
    return NextResponse.json(s, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    console.error("[shop-commission] order status error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
