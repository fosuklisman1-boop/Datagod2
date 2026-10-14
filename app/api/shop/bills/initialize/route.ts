import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { readJson } from "@/lib/bills/route-auth"
import { resolveShop } from "@/lib/storefront-commission/shop"
import { initializeStorefrontBill } from "@/lib/storefront-commission/bills"
import { getStorefrontBillsRuntime, storefrontGuards } from "@/lib/storefront-commission/runtime"

export const dynamic = "force-dynamic"

/** Public: create an UNPAID storefront bill order from a shop-bound verify token (paid later through checkout). */
export async function POST(request: NextRequest) {
  try {
    // Same per-IP budget as storefront airtime initialize.
    const { maxRequests, windowMs, message } = RATE_LIMITS.SHOP_AIRTIME_INITIALIZE
    const rl = await applyRateLimit(request, "shop_bills_initialize", maxRequests, windowMs)
    if (!rl.allowed) return NextResponse.json({ error: message }, { status: 429 })
    const body = await readJson(request)
    if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })

    const { deps, db } = getStorefrontBillsRuntime(request)
    const shop = await resolveShop(db, body.shopSlug)
    if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 })

    const blocked = await storefrontGuards(request, db, shop.id, body, { tag: "SHOP-BILLS-INIT", otpPhone: body.customerPhone })
    if (blocked) return NextResponse.json({ error: blocked.error, ...(blocked.code ? { code: blocked.code } : {}) }, { status: blocked.status })

    const r = await initializeStorefrontBill(deps, shop.id, {
      token: body.token, amount: body.amount, expectedPay: body.expectedPay,
      customerName: body.customerName, customerEmail: body.customerEmail, customerPhone: body.customerPhone,
    })
    if (!r.ok) return NextResponse.json({ error: r.error, ...(r.quote ? { quote: r.quote } : {}) }, { status: r.status })
    return NextResponse.json(r.value)
  } catch (e) {
    console.error("[shop-bills] initialize error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
