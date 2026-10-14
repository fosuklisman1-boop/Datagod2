import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { classifyServiceError } from "@/lib/api-v1-errors"
import { getSandboxOrder } from "@/lib/sandbox"
import { ORDER_COLUMNS, orderBody } from "@/lib/api-v1/bills"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/v1/bills/{reference} -- only the key owner's own order.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ reference: string }> }) {
  const start = Date.now()
  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rl = await applyRateLimit(request, "v1_bills_get", user.rate_limit_per_min || 60, 60 * 1000, user.id)
  if (!rl.allowed) {
    return NextResponse.json({ success: false, error: "Rate limit exceeded." }, { status: 429 })
  }

  const { reference } = await params
  if (!reference) {
    return NextResponse.json({ success: false, error: "Reference is required" }, { status: 400 })
  }

  const respond = (statusCode: number, body: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const order = body.order as { status?: unknown } | undefined
    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "GET", endpoint: "/api/v1/bills/{reference}",
      statusCode, request, durationMs: Date.now() - start,
      requestPayload: { reference },
      responsePayload: order ? { status: order.status, ...extra } : { error: body.error, ...extra },
    }).catch(() => {})
    return NextResponse.json(body, { status: statusCode })
  }

  try {
    if (user.environment === "test") {
      const order = await getSandboxOrder(user.id, reference)
      if (!order || order.action !== "utility_bill") {
        return respond(404, { success: false, error: "Order not found" }, { sandbox: true })
      }
      return respond(200, { success: true, order: { ...(order.response as Record<string, unknown>), status: order.status, sandbox: true } }, { sandbox: true })
    }

    const { data: order, error } = await supabase
      .from("hubtel_bill_orders")
      .select(ORDER_COLUMNS)
      .eq("reference_code", reference)
      .eq("user_id", user.id)
      .maybeSingle()
    // A database failure is a 500, never "not found".
    if (error) throw error

    if (!order) return respond(404, { success: false, error: "Order not found" })
    return respond(200, { success: true, order: orderBody(order as any) })
  } catch (e) {
    const { status, publicMessage } = classifyServiceError(e, {}, "Failed to load order")
    console.error("[V1-BILLS] status error:", e instanceof Error ? e.message : "error")
    return respond(status, { success: false, error: publicMessage })
  }
}
