import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { getBundlesRuntime } from "@/lib/standard-bundles/runtime"
import { BUNDLE_NETWORKS, type BundleNetwork } from "@/lib/standard-bundles/categories"
import { resolveShop } from "@/lib/storefront-commission/shop"
import { storefrontCatalog } from "@/lib/storefront-commission/bundles"

export const dynamic = "force-dynamic"

/** Public: GET ?shop=<handle>&network=MTN|TELECEL|AT — catalog with the storefront price on every bundle. */
export async function GET(request: NextRequest) {
  try {
    const rl = await applyRateLimit(request, "shop_bundles_catalog", 30, 60_000)
    if (!rl.allowed) return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 })
    const params = new URL(request.url).searchParams
    const network = params.get("network")
    if (!network || !(BUNDLE_NETWORKS as readonly string[]).includes(network)) {
      return NextResponse.json({ error: "network must be MTN, TELECEL or AT" }, { status: 400 })
    }
    const { deps, db } = getBundlesRuntime()
    const shop = await resolveShop(db, params.get("shop"))
    if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    const result = await storefrontCatalog(deps, network as BundleNetwork)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ categories: result.categories })
  } catch (e) {
    console.error("[shop-bundles] catalog error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
