import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { getBundlesRuntime } from "@/lib/standard-bundles/runtime"
import { getDashboardCatalog } from "@/lib/standard-bundles/special"
import { BUNDLE_NETWORKS, type BundleNetwork } from "@/lib/standard-bundles/categories"
import { authenticate } from "@/lib/bills/route-auth"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if ("response" in auth) return auth.response
    const rl = await applyRateLimit(request, "bundles_catalog", 30, 60_000, auth.userId)
    if (!rl.allowed) return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 })
    const network = new URL(request.url).searchParams.get("network")
    if (!network || !(BUNDLE_NETWORKS as readonly string[]).includes(network)) {
      return NextResponse.json({ error: "network must be MTN, TELECEL or AT" }, { status: 400 })
    }
    const { deps } = getBundlesRuntime()
    // Dashboard only: adds the MTN Special Bundles category when its switch is on.
    const result = await getDashboardCatalog(deps, network as BundleNetwork)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ categories: result.categories })
  } catch (e) {
    console.error("[bundles] catalog error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
