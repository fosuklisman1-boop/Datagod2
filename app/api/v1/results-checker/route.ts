// app/api/v1/results-checker/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { purchaseResultsCheckerVouchers, isValidExamBoard, isExamBoardEnabled, getMaxQuantity, calculateRCPrice } from "@/lib/results-checker-service"
import { deliverVouchers } from "@/lib/results-checker-notification-service"
import { classifyServiceError } from "@/lib/api-v1-errors"
import { placeSandboxOrder, getSandboxOrder } from "@/lib/sandbox"

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

  if (user.environment === "test") {
    const order = await getSandboxOrder(user.id, reference)
    if (!order) {
      return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 })
    }
    return NextResponse.json({ success: true, order: { ...order.response, status: order.status, sandbox: true } })
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

  const { exam_board, quantity, phone_number, email } = body
  if (!exam_board || !isValidExamBoard(exam_board)) {
    return NextResponse.json({ success: false, error: "exam_board must be one of WASSCE, BECE, NOVDEC" }, { status: 400 })
  }
  const maxQty = await getMaxQuantity()
  const qty = Number(quantity)
  if (!Number.isInteger(qty) || qty <= 0 || qty > maxQty) {
    return NextResponse.json({ success: false, error: `quantity must be a positive integer up to ${maxQty}` }, { status: 400 })
  }

  // Optional delivery overrides — if provided, used to SMS/email the voucher
  // PIN to a different end-customer (reselling); otherwise we fall back to
  // the API key owner's own profile after the purchase succeeds.
  if (phone_number !== undefined && phone_number !== null && String(phone_number).trim() !== "") {
    const cleanPhone = String(phone_number).replace(/\s/g, "")
    if (!/^\d{10}$/.test(cleanPhone)) {
      return NextResponse.json({ success: false, error: "phone_number must be a 10-digit phone number" }, { status: 400 })
    }
  }
  if (email !== undefined && email !== null && String(email).trim() !== "") {
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ success: false, error: "email must be a valid email address" }, { status: 400 })
    }
  }

  const boardEnabled = await isExamBoardEnabled(exam_board)
  if (!boardEnabled) {
    return NextResponse.json({ success: false, error: `${exam_board} vouchers are currently unavailable` }, { status: 503 })
  }

  if (user.environment === "test") {
    // Real, read-only pricing calculation -- but fake PINs, never a real
    // results_checker_inventory row, and no SMS/email actually sent.
    const pricing = await calculateRCPrice({ examBoard: exam_board, quantity: qty })
    const reference = `RC-SANDBOX-${Date.now().toString().slice(-8)}`
    const vouchers = Array.from({ length: qty }, (_, i) => ({
      pin: `TEST-${(Date.now() % 10000).toString().padStart(4, "0")}-${i.toString().padStart(4, "0")}`,
      serial_number: `SANDBOX-${exam_board}-${(i + 1).toString().padStart(4, "0")}`,
    }))
    const result = await placeSandboxOrder({
      userId: user.id,
      apiKeyId: user.api_key_id,
      action: "results_checker",
      reference,
      request: { exam_board, quantity: qty },
      price: pricing.totalPaid,
      orderFields: { exam_board, quantity: qty, total_paid: pricing.totalPaid },
      instant: true,
    })
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status })
    }
    return NextResponse.json({
      success: true,
      order: { ...result.order, sandbox: true },
      vouchers,
      new_balance: result.newBalance,
    }, { status: 201 })
  }

  // 30-second idempotency guard — mirrors app/api/results-checker/purchase/route.ts,
  // so a client retry (e.g. after a timeout) can't double-charge and double-issue PINs.
  const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString()
  const { data: recentOrder } = await supabase
    .from("results_checker_orders")
    .select("id, reference_code")
    .eq("user_id", user.id)
    .eq("exam_board", exam_board)
    .eq("quantity", qty)
    .eq("status", "pending")
    .gte("created_at", thirtySecondsAgo)
    .maybeSingle()

  if (recentOrder) {
    return NextResponse.json(
      { success: false, error: "Duplicate request detected. Please wait before trying again.", reference: recentOrder.reference_code },
      { status: 409 }
    )
  }

  try {
    const result = await purchaseResultsCheckerVouchers({ userId: user.id, examBoard: exam_board, quantity: qty })

    // Resolve delivery contact — explicit body overrides win, otherwise fall
    // back to the API key owner's own profile (mirrors the dashboard route's
    // default behavior at app/api/results-checker/purchase/route.ts).
    let resolvedPhone: string | null = phone_number ? String(phone_number).replace(/\s/g, "") : null
    let resolvedEmail: string | null = typeof email === "string" && email.trim() ? email.trim() : null

    // The purchase above already succeeded (wallet debited, vouchers assigned)
    // — everything from here is best-effort delivery. Wrap it in its own
    // try/catch so an unexpected throw here can't fall into the outer catch
    // and report a purchase failure for an order that actually went through.
    try {
      if (!resolvedPhone) {
        const { data: profile } = await supabase
          .from("users")
          .select("phone_number")
          .eq("id", user.id)
          .single()
        resolvedPhone = profile?.phone_number ?? null
      }
      if (!resolvedEmail) resolvedEmail = user.email ?? null

      // Persist contact info on the order so resend (SMS/email) can find it later.
      if (resolvedPhone || resolvedEmail) {
        const { error: persistError } = await supabase
          .from("results_checker_orders")
          .update({ customer_phone: resolvedPhone, customer_email: resolvedEmail, updated_at: new Date().toISOString() })
          .eq("id", result.order.id)
        if (persistError) {
          console.warn("[V1-RESULTS-CHECKER] Failed to persist contact info:", persistError)
        }
      }

      const orderWithContact = { ...result.order, customer_phone: resolvedPhone, customer_email: resolvedEmail }

      // Await delivery so the serverless function doesn't terminate before
      // Resend/mNotify HTTP calls complete (fire-and-forget is killed on Vercel).
      await deliverVouchers(orderWithContact, result.vouchers)
        .catch((e) => console.warn("[V1-RESULTS-CHECKER] Delivery error:", e))
    } catch (deliveryError) {
      console.warn("[V1-RESULTS-CHECKER] Contact resolution/delivery error:", deliveryError)
    }

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/results-checker",
      statusCode: 201, request, durationMs: Date.now() - start,
      requestPayload: { exam_board, quantity: qty, contact_phone: resolvedPhone, contact_email: resolvedEmail },
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
