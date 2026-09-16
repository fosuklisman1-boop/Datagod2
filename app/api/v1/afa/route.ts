// app/api/v1/afa/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { submitAfaOrder } from "@/lib/afa-fulfillment"
import { classifyServiceError } from "@/lib/api-v1-errors"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/v1/afa?reference=<order_code>
 */
export async function GET(request: NextRequest) {
  const start = Date.now()

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const rateLimit = await applyRateLimit(request, "v1_afa_get", rateLimitCount, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: "Rate limit exceeded." }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  const reference = searchParams.get("reference")
  if (!reference) {
    return NextResponse.json({ success: false, error: "Reference is required" }, { status: 400 })
  }

  const { data: order } = await supabase
    .from("afa_orders")
    .select("order_code, full_name, phone_number, amount, status, fulfillment_status, created_at")
    .eq("order_code", reference)
    .eq("user_id", user.id)
    .single()

  const statusCode = order ? 200 : 404
  logApiRequest({
    userId: user.id, apiKeyId: user.api_key_id, method: "GET", endpoint: "/api/v1/afa",
    statusCode, request, durationMs: Date.now() - start,
    requestPayload: { reference },
    responsePayload: order ? { reference: order.order_code, status: order.status } : { error: "Order not found" },
  }).catch(() => {})

  if (!order) {
    return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 })
  }

  return NextResponse.json({
    success: true,
    order: {
      reference: order.order_code,
      full_name: order.full_name,
      phone_number: order.phone_number,
      amount: order.amount,
      status: order.status,
      fulfillment_status: order.fulfillment_status,
      created_at: order.created_at,
    },
  })
}

/**
 * POST /api/v1/afa
 * Body: { full_name, phone_number, gh_card_number, location, region, occupation? }
 */
export async function POST(request: NextRequest) {
  const start = Date.now()

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const postLimit = Math.max(5, Math.floor(rateLimitCount / 3))
  const rateLimit = await applyRateLimit(request, "v1_afa_post", postLimit, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: `Rate limit exceeded. Your current limit is ${postLimit} requests/minute.` }, { status: 429 })
  }

  const phoneGuard = await checkPhoneVerified(supabase, user.id)
  if (!phoneGuard.allowed) {
    return NextResponse.json({ success: false, error: phoneGuard.error }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const { full_name, phone_number, gh_card_number, location, region, occupation } = body
  if (!full_name || !phone_number || !gh_card_number || !location || !region) {
    return NextResponse.json(
      { success: false, error: "Missing required fields: full_name, phone_number, gh_card_number, location, region" },
      { status: 400 }
    )
  }

  try {
    const result = await submitAfaOrder({
      userId: user.id, fullName: full_name, phoneNumber: phone_number, ghCardNumber: gh_card_number, location, region, occupation,
    })

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/afa",
      statusCode: 201, request, durationMs: Date.now() - start,
      requestPayload: { full_name, phone_number, region },
      responsePayload: { reference: result.order.order_code, status: result.order.status },
    }).catch(() => {})

    return NextResponse.json({
      success: true,
      order: {
        reference: result.order.order_code,
        full_name: result.order.full_name,
        phone_number: result.order.phone_number,
        amount: result.order.amount,
        status: result.order.status,
        created_at: result.order.created_at,
      },
    }, { status: 201 })
  } catch (error: any) {
    const { status, publicMessage, isKnown } = classifyServiceError(error, {
      PRICE_UNAVAILABLE: 503,
      INSUFFICIENT_BALANCE: 402,
      PAYMENT_FAILED: 500,
      ORDER_CREATE_FAILED: 500,
    }, "Failed to submit AFA order")

    if (!isKnown) {
      console.error("[V1-AFA] Unexpected error:", error)
    }

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/afa",
      statusCode: status, request, durationMs: Date.now() - start,
      requestPayload: { full_name, phone_number, region },
      responsePayload: { error: publicMessage },
    }).catch(() => {})

    return NextResponse.json({ success: false, error: publicMessage, required: error?.required }, { status })
  }
}
