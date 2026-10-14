import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
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

  if (user.environment === "test") {
    const order = await getSandboxOrder(user.id, reference)
    if (!order || (order.response as any)?.kind !== "utility_bill") {
      return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 })
    }
    const { kind: _k, ...rest } = order.response as Record<string, unknown>
    return NextResponse.json({ success: true, order: { ...rest, status: order.status, sandbox: true } })
  }

  const { data: order } = await supabase
    .from("hubtel_bill_orders")
    .select(ORDER_COLUMNS)
    .eq("reference_code", reference)
    .eq("user_id", user.id)
    .maybeSingle()

  const statusCode = order ? 200 : 404
  logApiRequest({
    userId: user.id, apiKeyId: user.api_key_id, method: "GET", endpoint: "/api/v1/bills/{reference}",
    statusCode, request, durationMs: Date.now() - start,
    requestPayload: { reference },
    responsePayload: order ? { status: (order as any).status } : { error: "Order not found" },
  }).catch(() => {})

  if (!order) {
    return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 })
  }
  return NextResponse.json({ success: true, order: orderBody(order as any) })
}
