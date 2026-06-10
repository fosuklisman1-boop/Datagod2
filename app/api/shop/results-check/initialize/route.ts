import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { shopHandleOrFilter } from "@/lib/shop-handle"
import {
  EXAM_BOARDS,
  isValidIndexNumber,
  isValidVoucherPin,
  isValidVoucherSerial,
  isValidDob,
  isValidExamYear,
  isValidGhanaPhone,
  type ExamBoard,
} from "@/lib/results-check-validation"
import {
  isExamBoardEnabled,
  getAvailableCount,
  calculateResultsCheckPrice,
} from "@/lib/results-checker-service"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { verifyShopSession } from "@/lib/shop-token"
import { verifyTurnstileToken, getRequestIp, isTurnstileEnabled } from "@/lib/turnstile"
import { isStorefrontOtpRequired, isPhoneOtpVerified } from "@/lib/storefront-otp"
import { secureReference } from "@/lib/secure-random"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const VALID_CANDIDATE_TYPES = new Set(["school", "private"])
const VALID_MODES = new Set(["combo", "own_voucher"])

function generateRCKReference(): string {
  return secureReference("RCK", 2, 3)
}

export async function POST(request: NextRequest) {
  try {
    // IP rate limit: 5/min per IP — unauthenticated abuse surface
    const rateLimit = await applyRateLimit(
      request,
      "shop_rc_check_initialize",
      RATE_LIMITS.SHOP_RC_CHECK_INITIALIZE.maxRequests,
      RATE_LIMITS.SHOP_RC_CHECK_INITIALIZE.windowMs
    )
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: RATE_LIMITS.SHOP_RC_CHECK_INITIALIZE.message },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": RATE_LIMITS.SHOP_RC_CHECK_INITIALIZE.maxRequests.toString(),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": new Date(rateLimit.resetAt).toISOString(),
          },
        }
      )
    }

    const body = await request.json()
    const {
      shopSlug,
      examBoard,
      candidateType,
      mode,
      indexNumber,
      examYear: rawExamYear,
      dob,
      voucherPin,
      voucherSerial,
      customerName,
      customerEmail,
      phoneNumber,
      whatsappNumber,
      paymentPhone,
      turnstileToken,
      website: honeypot,
    } = body

    // SECURITY: shopId must always be resolved server-side from the slug — never
    // trusted from the client body.
    if (!shopSlug || typeof shopSlug !== "string" || !shopSlug.trim()) {
      return NextResponse.json({ error: "shopSlug is required" }, { status: 400 })
    }

    const { data: shopRow, error: shopErr } = await supabase
      .from("user_shops")
      .select("id")
      .or(shopHandleOrFilter(shopSlug.trim()))
      .single()
    if (shopErr || !shopRow) {
      console.warn(`[RCK-SHOP-INIT] ❌ Shop not found for slug=${shopSlug}`)
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }
    const shopId = shopRow.id

    // Honeypot: hidden form field that real users never fill. Any non-empty value = bot.
    if (typeof honeypot === "string" && honeypot.trim() !== "") {
      console.warn(`[RCK-SHOP-INIT] ❌ Honeypot tripped: bot detected for shop ${shopId} value_len=${honeypot.length}`)
      return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    }

    if (!examBoard || !candidateType || !mode || !indexNumber || !rawExamYear || !dob || !customerEmail || !phoneNumber || !whatsappNumber) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }

    // Turnstile CAPTCHA verification — admin can disable globally via toggle.
    const turnstileEnabled = await isTurnstileEnabled()
    if (!turnstileEnabled) {
      console.warn(`[RCK-SHOP-INIT] ⚠️ Turnstile DISABLED by admin toggle — skipping verification for shop ${shopId}`)
    } else {
      const turnstileResult = await verifyTurnstileToken(turnstileToken, getRequestIp(request.headers))
      if (!turnstileResult.valid) {
        console.warn(`[RCK-SHOP-INIT] ❌ Turnstile verification failed (${turnstileResult.reason}) for shop ${shopId} turnstile_configured=${!!process.env.TURNSTILE_SECRET_KEY} token_present=${!!turnstileToken}`)
        return NextResponse.json({ error: "Verification failed. Please refresh the page and try again." }, { status: 403 })
      }
      console.log(`[RCK-SHOP-INIT] ✓ Turnstile passed for shop ${shopId}`)
    }

    // __shop_sess cookie binding — DISABLED by default. Re-enable via SHOP_SESSION_ENFORCED=true.
    if (process.env.SHOP_SESSION_ENFORCED === "true") {
      const shopCookie = request.cookies.get("__shop_sess")?.value
      if (!shopCookie) {
        console.warn(`[RCK-SHOP-INIT] ❌ Blocked: missing __shop_sess cookie for shop ${shopId}`)
        return NextResponse.json({ error: "Invalid session. Please refresh the page and try again." }, { status: 403 })
      }
      const { data: shopForCookie } = await supabase
        .from("user_shops")
        .select("shop_slug")
        .eq("id", shopId)
        .single()
      if (!shopForCookie?.shop_slug) {
        console.warn(`[RCK-SHOP-INIT] ❌ Shop not found for cookie verification: ${shopId}`)
        return NextResponse.json({ error: "Shop not found" }, { status: 404 })
      }
      const cookieCheck = verifyShopSession(shopCookie, shopForCookie.shop_slug)
      if (!cookieCheck.valid) {
        console.warn(`[RCK-SHOP-INIT] ❌ Invalid shop session cookie (${cookieCheck.reason}) for shop ${shopId} expected_slug=${shopForCookie.shop_slug} secret_configured=${!!process.env.SHOP_TOKEN_SECRET}`)
        return NextResponse.json({ error: "Invalid session. Please refresh the page and try again." }, { status: 403 })
      }
      console.log(`[RCK-SHOP-INIT] ✓ Cookie valid for shop ${shopId} slug=${shopForCookie.shop_slug}`)
    }

    // Checkout phone-OTP gate (admin toggle). Verifies the PAYMENT number.
    if (await isStorefrontOtpRequired()) {
      const numberToVerify = (paymentPhone && String(paymentPhone).trim()) || phoneNumber
      const verified = await isPhoneOtpVerified(numberToVerify)
      if (!verified) {
        console.warn(`[RCK-SHOP-INIT] ❌ Payment number not OTP-verified for shop ${shopId}`)
        return NextResponse.json(
          { error: "Please verify your payment number to continue.", code: "OTP_REQUIRED" },
          { status: 403 }
        )
      }
      console.log(`[RCK-SHOP-INIT] ✓ Payment number OTP-verified for shop ${shopId}`)
    }

    // --- Validation ---
    if (!EXAM_BOARDS.includes(examBoard)) {
      return NextResponse.json({ error: "Invalid examBoard. Must be WASSCE, BECE, or NOVDEC" }, { status: 400 })
    }
    const board = examBoard as ExamBoard

    if (!VALID_CANDIDATE_TYPES.has(candidateType)) {
      return NextResponse.json({ error: "Invalid candidateType. Must be school or private" }, { status: 400 })
    }

    if (!VALID_MODES.has(mode)) {
      return NextResponse.json({ error: "Invalid mode. Must be combo or own_voucher" }, { status: 400 })
    }

    if (!isValidIndexNumber(board, String(indexNumber).trim())) {
      return NextResponse.json({ error: "Invalid index number format" }, { status: 400 })
    }

    const examYear = parseInt(rawExamYear)
    if (!isValidExamYear(examYear)) {
      return NextResponse.json({ error: "Invalid exam year" }, { status: 400 })
    }

    if (!isValidDob(String(dob))) {
      return NextResponse.json({ error: "Invalid date of birth. Use DD/MM/YYYY" }, { status: 400 })
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customerEmail))) {
      return NextResponse.json({ error: "Valid email is required" }, { status: 400 })
    }

    if (!isValidGhanaPhone(String(phoneNumber))) {
      return NextResponse.json({ error: "Invalid phone number" }, { status: 400 })
    }

    if (!isValidGhanaPhone(String(whatsappNumber))) {
      return NextResponse.json({ error: "Invalid WhatsApp number" }, { status: 400 })
    }

    let normalizedVoucherPin: string | null = null
    let normalizedVoucherSerial: string | null = null
    if (mode === "own_voucher") {
      if (!voucherPin || !isValidVoucherPin(String(voucherPin))) {
        return NextResponse.json({ error: "Invalid voucher PIN. Must be 12 digits" }, { status: 400 })
      }
      if (!voucherSerial || !isValidVoucherSerial(String(voucherSerial))) {
        return NextResponse.json({ error: "Invalid voucher serial number" }, { status: 400 })
      }
      normalizedVoucherPin = String(voucherPin).trim()
      normalizedVoucherSerial = String(voucherSerial).trim().toUpperCase()
    }

    // Service-level toggle
    const settings = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "results_check_settings")
      .single()
    if (settings.data?.value?.enabled === false) {
      return NextResponse.json({ error: "Results Check Service is currently unavailable" }, { status: 503 })
    }

    const enabled = await isExamBoardEnabled(board)
    if (!enabled) {
      return NextResponse.json({ error: `${board} results checking is currently unavailable` }, { status: 503 })
    }

    // Combo mode: re-check inventory before creating the request (defense in depth —
    // the form should already hide combo when stock is 0).
    if (mode === "combo") {
      const availableCount = await getAvailableCount(board)
      if (availableCount < 1) {
        return NextResponse.json(
          { error: `${board} vouchers are currently out of stock. Please choose "I have my own voucher" instead.` },
          { status: 409 }
        )
      }
    }

    // Verify shop exists
    const { data: shop } = await supabase
      .from("user_shops")
      .select("id, shop_name")
      .eq("id", shopId)
      .single()

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // Atomic flood guards via Upstash sliding window — closes the count→insert
    // race. Fails open if Upstash misconfigured; DB checks below remain as fallback.
    const [emailCapRCK, shop5mCapRCK, shop1hCapRCK] = await Promise.all([
      applyRateLimit(request, "shop_rck_cap_email", 5, 60 * 60 * 1000, `e:${customerEmail.toLowerCase()}`),
      applyRateLimit(request, "shop_rck_cap_shop_5m", 15, 5 * 60 * 1000, `s:${shopId}`),
      applyRateLimit(request, "shop_rck_cap_shop_1h", 60, 60 * 60 * 1000, `s:${shopId}`),
    ])
    if (!emailCapRCK.allowed) {
      console.warn(`[RCK-SHOP-INIT] ❌ Atomic email cap hit for shop ${shopId}`)
      return NextResponse.json(
        { error: "Too many pending requests. Please complete or wait for existing requests to expire." },
        { status: 429 }
      )
    }
    if (!shop5mCapRCK.allowed || !shop1hCapRCK.allowed) {
      console.warn(`[RCK-SHOP-INIT] ❌ Atomic shop cap hit (5m_allowed=${shop5mCapRCK.allowed} 1h_allowed=${shop1hCapRCK.allowed}) for shop ${shopId}`)
      return NextResponse.json(
        { error: "Too many pending requests for this shop. Please try again shortly." },
        { status: 429 }
      )
    }

    // DB-level flood guards — backup defence in case Upstash is unavailable.
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    const [{ count: pendingByEmail }, { count: pendingByShop5m }, { count: pendingByShop1h }] = await Promise.all([
      supabase
        .from("results_check_requests")
        .select("id", { count: "exact", head: true })
        .eq("customer_email", customerEmail)
        .eq("payment_status", "pending_payment")
        .gte("created_at", oneHourAgo),
      supabase
        .from("results_check_requests")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", shopId)
        .eq("payment_status", "pending_payment")
        .gte("created_at", fiveMinutesAgo),
      supabase
        .from("results_check_requests")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", shopId)
        .eq("payment_status", "pending_payment")
        .gte("created_at", oneHourAgo),
    ])

    if ((pendingByEmail ?? 0) >= 5) {
      return NextResponse.json(
        { error: "Too many pending requests. Please complete or wait for existing requests to expire." },
        { status: 429 }
      )
    }
    if ((pendingByShop5m ?? 0) >= 15 || (pendingByShop1h ?? 0) >= 60) {
      return NextResponse.json(
        { error: "Too many pending requests for this shop. Please try again shortly." },
        { status: 429 }
      )
    }

    const pricing = await calculateResultsCheckPrice({ examBoard: board, mode, shopId })
    const reference = generateRCKReference()

    const { data: requestRow, error: insertError } = await supabase
      .from("results_check_requests")
      .insert([{
        phone_number: phoneNumber,
        exam_board: board,
        candidate_type: candidateType,
        index_number: String(indexNumber).trim(),
        dob: String(dob).trim(),
        exam_year: examYear,
        fee: pricing.totalPaid,
        mode,
        voucher_pin: normalizedVoucherPin,
        voucher_serial: normalizedVoucherSerial,
        whatsapp_number: whatsappNumber || null,
        payment_status: "pending_payment",
        status: "pending",
        channel: "web",
        payment_reference: reference,
        customer_name: customerName ?? "Guest",
        customer_email: customerEmail,
        shop_id: shopId,
        merchant_commission: pricing.merchantCommission,
      }])
      .select()
      .single()

    if (insertError || !requestRow) {
      console.error("[RCK-SHOP-INIT] Request creation error:", insertError)
      return NextResponse.json({ error: "Failed to initialize request" }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      orderId: requestRow.id,
      totalPrice: pricing.totalPaid,
      reference,
      mode,
    })

  } catch (error) {
    console.error("[RCK-SHOP-INIT] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
