import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { purchaseAirtime } from "@/lib/airtime-service"
import { classifyServiceError } from "@/lib/api-v1-errors"
import { placeSandboxOrder, getSandboxOrder } from "@/lib/sandbox"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const ALLOWED_NETWORKS = ["MTN", "AirtelTigo", "Telecel"]

/**
 * GET /api/v1/airtime?reference=<ref>
 */
export async function GET(request: NextRequest) {
  const start = Date.now()

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const rateLimit = await applyRateLimit(request, "v1_airtime_get", rateLimitCount, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: "Rate limit exceeded." }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  const reference = searchParams.get("reference")
  if (!reference) {
    return NextResponse.json({ success: false, error: "Reference is required" }, { status: 400 })
  }

  if (user.environment === "test") {
    const order = await getSandboxOrder(user.id, reference)
    if (!order) {
      return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 })
    }
    return NextResponse.json({ success: true, order: { ...order.response, status: order.status, sandbox: true } })
  }

  const { data: order } = await supabase
    .from("airtime_orders")
    .select("reference_code, network, beneficiary_phone, airtime_amount, total_paid, status, created_at")
    .eq("reference_code", reference)
    .eq("user_id", user.id)
    .single()

  const statusCode = order ? 200 : 404
  logApiRequest({
    userId: user.id, apiKeyId: user.api_key_id, method: "GET", endpoint: "/api/v1/airtime",
    statusCode, request, durationMs: Date.now() - start,
    requestPayload: { reference },
    responsePayload: order ? { reference: order.reference_code, status: order.status } : { error: "Order not found" },
  }).catch(() => {})

  if (!order) {
    return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 })
  }

  return NextResponse.json({
    success: true,
    order: {
      reference: order.reference_code,
      network: order.network,
      recipient: order.beneficiary_phone,
      airtime_amount: order.airtime_amount,
      total_paid: order.total_paid,
      status: order.status,
      created_at: order.created_at,
    },
  })
}

/**
 * POST /api/v1/airtime
 * Body: { network: "MTN"|"AirtelTigo"|"Telecel", recipient: string, amount: number, pay_separately?: boolean }
 */
export async function POST(request: NextRequest) {
  const start = Date.now()

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const postLimit = Math.max(5, Math.floor(rateLimitCount / 3))
  const rateLimit = await applyRateLimit(request, "v1_airtime_post", postLimit, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: `Rate limit exceeded. Your current limit is ${postLimit} requests/minute.` }, { status: 429 })
  }

  // Phone verification is a real-money/real-customer compliance guard --
  // doesn't apply to a test key since nothing real happens.
  if (user.environment !== "test") {
    const phoneGuard = await checkPhoneVerified(supabase, user.id)
    if (!phoneGuard.allowed) {
      return NextResponse.json({ success: false, error: phoneGuard.error }, { status: 403 })
    }
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const { network, recipient, amount, pay_separately = false } = body
  if (!network || !recipient || !amount) {
    return NextResponse.json({ success: false, error: "Missing required fields: network, recipient, amount" }, { status: 400 })
  }
  if (!ALLOWED_NETWORKS.includes(network)) {
    return NextResponse.json({ success: false, error: "Invalid network. Must be MTN, AirtelTigo, or Telecel" }, { status: 400 })
  }
  const cleanPhone = String(recipient).replace(/\s/g, "")
  if (!/^\d{10}$/.test(cleanPhone)) {
    return NextResponse.json({ success: false, error: "recipient must be a 10-digit phone number" }, { status: 400 })
  }
  const numericAmount = Number(amount)
  if (!Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > 1000) {
    return NextResponse.json({ success: false, error: "amount must be between GHS 0.01 and GHS 1000" }, { status: 400 })
  }

  if (user.environment === "test") {
    const { secureReference } = await import("@/lib/secure-random")
    const reference = secureReference("AT", 2, 3)
    // Sandbox charges a flat amount == the requested airtime value; the real
    // endpoint's processing fee isn't simulated.
    const result = await placeSandboxOrder({
      userId: user.id,
      apiKeyId: user.api_key_id,
      action: "airtime",
      reference,
      request: { network, recipient: cleanPhone, amount: numericAmount, pay_separately },
      price: numericAmount,
      orderFields: { network, recipient: cleanPhone, airtime_amount: numericAmount, total_paid: numericAmount },
    })
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status })
    }
    return NextResponse.json(
      { success: true, order: { ...result.order, sandbox: true }, new_balance: result.newBalance },
      { status: 201 }
    )
  }

  try {
    const result = await purchaseAirtime({
      userId: user.id, network, beneficiaryPhone: cleanPhone, airtimeAmount: numericAmount, paySeparately: pay_separately,
    })

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/airtime",
      statusCode: 201, request, durationMs: Date.now() - start,
      requestPayload: { network, recipient: cleanPhone, amount: numericAmount },
      responsePayload: { reference: result.order.reference_code, status: result.order.status },
    }).catch(() => {})

    return NextResponse.json({ success: true, order: result.order, new_balance: result.newBalance }, { status: 201 })
  } catch (error: any) {
    const { status, publicMessage, isKnown } = classifyServiceError(error, {
      NETWORK_DISABLED: 503,
      NETWORK_MISMATCH: 400,
      INVALID_AMOUNT: 400,
      DUPLICATE_REQUEST: 409,
      INSUFFICIENT_BALANCE: 402,
      PAYMENT_FAILED: 500,
      ORDER_CREATE_FAILED: 500,
    }, "Failed to purchase airtime")

    if (!isKnown) {
      console.error("[V1-AIRTIME] Unexpected error:", error)
    }

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/airtime",
      statusCode: status, request, durationMs: Date.now() - start,
      requestPayload: { network, recipient: cleanPhone, amount: numericAmount },
      responsePayload: { error: publicMessage },
    }).catch(() => {})

    return NextResponse.json(
      { success: false, error: publicMessage, required: error?.required, reference: error?.reference },
      { status }
    )
  }
}
