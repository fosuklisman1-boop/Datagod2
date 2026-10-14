import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { readJson } from "@/lib/bills/route-auth"
import { resolveShop } from "@/lib/storefront-commission/shop"
import { verifyStorefrontBill } from "@/lib/storefront-commission/bills"
import { getStorefrontBillsRuntime, storefrontGuards } from "@/lib/storefront-commission/runtime"

export const dynamic = "force-dynamic"

const TOO_MANY = "Too many requests. Please slow down."

/** Public storefront account lookup. The token it returns is bound to this shop. */
export async function POST(request: NextRequest) {
  try {
    const rl = await applyRateLimit(request, "shop_bills_verify", 20, 10 * 60_000)
    if (!rl.allowed) return NextResponse.json({ error: TOO_MANY }, { status: 429 })
    const body = await readJson(request)
    if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })

    const { deps, db } = getStorefrontBillsRuntime(request)
    const shop = await resolveShop(db, body.shopSlug)
    if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    // Turnstile is mandatory here (fails closed when disabled / not configured): verify reveals account data.
    const blocked = await storefrontGuards(request, db, shop.id, body, { tag: "SHOP-BILLS-VERIFY", requireTurnstile: true })
    if (blocked) return NextResponse.json({ error: blocked.error, ...(blocked.code ? { code: blocked.code } : {}) }, { status: blocked.status })

    // Only requests that passed the human check spend the shop's and the global budgets (no lock-out by junk posts).
    const perShop = await applyRateLimit(request, "shop_bills_verify_shop", 120, 60 * 60_000, `s:${shop.id}`)
    if (!perShop.allowed) return NextResponse.json({ error: TOO_MANY }, { status: 429 })
    const global = await applyRateLimit(request, "shop_bills_verify_global", 1000, 60 * 60_000, "all-shops")
    if (!global.allowed) return NextResponse.json({ error: TOO_MANY }, { status: 429 })

    const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined)
    const result = await verifyStorefrontBill(deps, shop.id, String(body.biller ?? ""), {
      phone: s(body.phone), account: s(body.account), email: s(body.email), broadbandAccount: s(body.broadbandAccount),
      addMeter: body.addMeter === true, consent: body.consent === true,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    const { ok: _ok, ...rest } = result
    return NextResponse.json({ success: true, ...rest })
  } catch (e) {
    console.error("[shop-bills] verify error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
