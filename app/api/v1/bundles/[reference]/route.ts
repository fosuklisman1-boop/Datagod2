import { NextRequest, NextResponse } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { getBundlesRuntime } from "@/lib/standard-bundles/runtime"
import { getSandboxOrder } from "@/lib/sandbox"
import { ORDER_COLUMNS, mapOrder } from "@/lib/api-v1/bundles"

export const dynamic = "force-dynamic"

/** GET /api/v1/bundles/{reference} -- the key owner's own order only. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ reference: string }> }) {
  const start = Date.now()
  const user = await authenticateApiKey(request)
  if (!user) return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })

  const limit = user.rate_limit_per_min || 60
  const rl = await applyRateLimit(request, "v1_bundles_get", limit, 60 * 1000, user.id)
  if (!rl.allowed) return NextResponse.json({ success: false, error: "Rate limit exceeded." }, { status: 429 })

  const { reference } = await params
  if (!reference) return NextResponse.json({ success: false, error: "Reference is required" }, { status: 400 })

  if (user.environment === "test") {
    const order = await getSandboxOrder(user.id, reference)
    if (!order || order.action !== "standard_bundle") {
      return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 })
    }
    return NextResponse.json({ success: true, order: { ...(order.response as object), status: order.status, sandbox: true } })
  }

  try {
    const { db } = getBundlesRuntime()
    const { data, error } = await db
      .from("hubtel_data_orders")
      .select(ORDER_COLUMNS)
      .eq("reference_code", reference)
      .eq("user_id", user.id)
      .maybeSingle()
    if (error) throw error

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "GET", endpoint: "/api/v1/bundles/{reference}",
      statusCode: data ? 200 : 404, request, durationMs: Date.now() - start, requestPayload: { reference },
    }).catch(() => {})

    if (!data) return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 })
    return NextResponse.json({ success: true, order: mapOrder(data as any) })
  } catch (e) {
    console.error("[V1-BUNDLES] status error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ success: false, error: "Failed to load order" }, { status: 500 })
  }
}
