import { NextRequest, NextResponse } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { classifyServiceError } from "@/lib/api-v1-errors"
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

  const respond = (statusCode: number, body: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const order = body.order as { status?: unknown } | undefined
    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "GET", endpoint: "/api/v1/bundles/{reference}",
      statusCode, request, durationMs: Date.now() - start, requestPayload: { reference },
      responsePayload: order ? { status: order.status, ...extra } : { error: body.error, ...extra },
    }).catch(() => {})
    return NextResponse.json(body, { status: statusCode })
  }

  try {
    if (user.environment === "test") {
      const order = await getSandboxOrder(user.id, reference)
      if (!order || order.action !== "standard_bundle") {
        return respond(404, { success: false, error: "Order not found" }, { sandbox: true })
      }
      return respond(200, { success: true, order: { ...(order.response as object), status: order.status, sandbox: true } }, { sandbox: true })
    }

    const { db } = getBundlesRuntime()
    const { data, error } = await db
      .from("hubtel_data_orders")
      .select(ORDER_COLUMNS)
      .eq("reference_code", reference)
      .eq("user_id", user.id)
      .maybeSingle()
    if (error) throw error

    if (!data) return respond(404, { success: false, error: "Order not found" })
    return respond(200, { success: true, order: mapOrder(data as any) })
  } catch (e) {
    const { status, publicMessage } = classifyServiceError(e, {}, "Failed to load order")
    console.error("[V1-BUNDLES] status error:", e instanceof Error ? e.message : "error")
    return respond(status, { success: false, error: publicMessage })
  }
}
