// app/api/v1/results-checker/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { purchaseResultsCheckerVouchers, isValidExamBoard } from "@/lib/results-checker-service"
import { classifyServiceError } from "@/lib/api-v1-errors"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/v1/results-checker?reference=<reference_code>
 */
export async function GET(request: NextRequest) {
  const start = Date.now()

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const rateLimit = await applyRateLimit(request, "v1_results_checker_get", rateLimitCount, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: "Rate limit exceeded." }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  const reference = searchParams.get("reference")
  if (!reference) {
    return NextResponse.json({ success: false, error: "Reference is required" }, { status: 400 })
  }

  const { data: order } = await supabase
    .from("results_checker_orders")
    .select("reference_code, exam_board, quantity, unit_price, total_paid, status, created_at")
    .eq("reference_code", reference)
    .eq("user_id", user.id)
    .single()

  const statusCode = order ? 200 : 404
  logApiRequest({
    userId: user.id, apiKeyId: user.api_key_id, method: "GET", endpoint: "/api/v1/results-checker",
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
      exam_board: order.exam_board,
      quantity: order.quantity,
      unit_price: order.unit_price,
      total_paid: order.total_paid,
      status: order.status,
      created_at: order.created_at,
    },
  })
}

/**
 * POST /api/v1/results-checker
 * Body: { exam_board: "WASSCE"|"BECE"|"NOVDEC", quantity: number }
 */
export async function POST(request: NextRequest) {
  const start = Date.now()

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const postLimit = Math.max(5, Math.floor(rateLimitCount / 3))
  const rateLimit = await applyRateLimit(request, "v1_results_checker_post", postLimit, 60 * 1000, user.id)
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

  const { exam_board, quantity } = body
  if (!exam_board || !isValidExamBoard(exam_board)) {
    return NextResponse.json({ success: false, error: "exam_board must be one of WASSCE, BECE, NOVDEC" }, { status: 400 })
  }
  const qty = Number(quantity)
  if (!Number.isInteger(qty) || qty <= 0 || qty > 50) {
    return NextResponse.json({ success: false, error: "quantity must be a positive integer up to 50" }, { status: 400 })
  }

  try {
    const result = await purchaseResultsCheckerVouchers({ userId: user.id, examBoard: exam_board, quantity: qty })

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/results-checker",
      statusCode: 201, request, durationMs: Date.now() - start,
      requestPayload: { exam_board, quantity: qty },
      responsePayload: { reference: result.order.reference_code, voucher_count: result.vouchers.length },
    }).catch(() => {})

    return NextResponse.json({
      success: true,
      order: {
        reference: result.order.reference_code,
        exam_board,
        quantity: qty,
        total_paid: result.order.total_paid,
        status: "completed",
      },
      vouchers: result.vouchers.map((v) => ({ pin: v.pin, serial_number: v.serial_number })),
      new_balance: result.newBalance,
    }, { status: 201 })
  } catch (error: any) {
    const { status, publicMessage, isKnown } = classifyServiceError(error, {
      INSUFFICIENT_BALANCE: 402,
      INSUFFICIENT_INVENTORY: 503,
    }, "Failed to purchase vouchers")

    if (!isKnown) {
      console.error("[V1-RESULTS-CHECKER] Unexpected error:", error)
    }

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/results-checker",
      statusCode: status, request, durationMs: Date.now() - start,
      requestPayload: { exam_board, quantity: qty },
      responsePayload: { error: publicMessage },
    }).catch(() => {})

    return NextResponse.json({ success: false, error: publicMessage, required: error?.required }, { status })
  }
}
