import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import {
  isValidExamBoard,
  isExamBoardEnabled,
  getMaxQuantity,
  calculateRCPrice,
} from "@/lib/results-checker-service"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { verifyShopSession } from "@/lib/shop-token"
import { verifyTurnstileToken, getRequestIp } from "@/lib/turnstile"
import { secureReference } from "@/lib/secure-random"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function generateRCReference(): string {
  return secureReference("RC", 2, 3)
}

export async function POST(request: NextRequest) {
  try {
    // IP rate limit: 5/min per IP — unauthenticated abuse surface
    const rateLimit = await applyRateLimit(
      request,
      "shop_rc_initialize",
      RATE_LIMITS.SHOP_RC_INITIALIZE.maxRequests,
      RATE_LIMITS.SHOP_RC_INITIALIZE.windowMs
    )
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: RATE_LIMITS.SHOP_RC_INITIALIZE.message },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": RATE_LIMITS.SHOP_RC_INITIALIZE.maxRequests.toString(),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": new Date(rateLimit.resetAt).toISOString(),
          },
        }
      )
    }

    const body = await request.json()
    const { shopId, examBoard, quantity: rawQuantity, customerName, customerEmail, customerPhone, turnstileToken, website: honeypot } = body

    // Honeypot: hidden form field that real users never fill. Any non-empty value = bot.
    if (typeof honeypot === "string" && honeypot.trim() !== "") {
      console.warn(`[RC-SHOP-INIT] ❌ Honeypot tripped: bot detected for shop ${shopId} value_len=${honeypot.length}`)
      return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    }

    if (!shopId || !examBoard || !rawQuantity || !customerEmail) {
      return NextResponse.json({ error: "shopId, examBoard, quantity, and customerEmail are required" }, { status: 400 })
    }

    // Turnstile CAPTCHA verification — fresh token required per form submission.
    const turnstileResult = await verifyTurnstileToken(turnstileToken, getRequestIp(request.headers))
    if (!turnstileResult.valid) {
      console.warn(`[RC-SHOP-INIT] ❌ Turnstile verification failed (${turnstileResult.reason}) for shop ${shopId} turnstile_configured=${!!process.env.TURNSTILE_SECRET_KEY} token_present=${!!turnstileToken}`)
      return NextResponse.json({ error: "Verification failed. Please refresh the page and try again." }, { status: 403 })
    }
    console.log(`[RC-SHOP-INIT] ✓ Turnstile passed for shop ${shopId}`)

    // Require __shop_sess cookie bound to this shop's current slug.
    const shopCookie = request.cookies.get("__shop_sess")?.value
    if (!shopCookie) {
      console.warn(`[RC-SHOP-INIT] ❌ Blocked: missing __shop_sess cookie for shop ${shopId}`)
      return NextResponse.json({ error: "Invalid session. Please refresh the page and try again." }, { status: 403 })
    }
    const { data: shopForCookie } = await supabase
      .from("user_shops")
      .select("shop_slug")
      .eq("id", shopId)
      .single()
    if (!shopForCookie?.shop_slug) {
      console.warn(`[RC-SHOP-INIT] ❌ Shop not found for cookie verification: ${shopId}`)
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }
    const cookieCheck = verifyShopSession(shopCookie, shopForCookie.shop_slug)
    if (!cookieCheck.valid) {
      console.warn(`[RC-SHOP-INIT] ❌ Invalid shop session cookie (${cookieCheck.reason}) for shop ${shopId} expected_slug=${shopForCookie.shop_slug} secret_configured=${!!process.env.SHOP_TOKEN_SECRET}`)
      return NextResponse.json({ error: "Invalid session. Please refresh the page and try again." }, { status: 403 })
    }
    console.log(`[RC-SHOP-INIT] ✓ Cookie valid for shop ${shopId} slug=${shopForCookie.shop_slug}`)

    if (!isValidExamBoard(examBoard)) {
      return NextResponse.json({ error: "Invalid examBoard. Must be WAEC, BECE, or NOVDEC" }, { status: 400 })
    }

    const quantity = parseInt(rawQuantity)
    if (isNaN(quantity) || quantity < 1) {
      return NextResponse.json({ error: "quantity must be a positive integer" }, { status: 400 })
    }

    const maxQty = await getMaxQuantity()
    if (quantity > maxQty) {
      return NextResponse.json({ error: `Maximum ${maxQty} vouchers per order` }, { status: 400 })
    }

    const enabled = await isExamBoardEnabled(examBoard)
    if (!enabled) {
      return NextResponse.json({ error: `${examBoard} vouchers are currently unavailable` }, { status: 503 })
    }

    // Check available inventory before creating order
    const { count: availableCount } = await supabase
      .from("results_checker_inventory")
      .select("id", { count: "exact", head: true })
      .eq("exam_board", examBoard)
      .eq("status", "available")

    if ((availableCount ?? 0) < quantity) {
      return NextResponse.json(
        { error: availableCount === 0
            ? `${examBoard} vouchers are currently out of stock`
            : `Only ${availableCount} ${examBoard} voucher${availableCount === 1 ? "" : "s"} available` },
        { status: 409 }
      )
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
    const [emailCapRC, shop5mCapRC, shop1hCapRC] = await Promise.all([
      applyRateLimit(request, "shop_rc_cap_email", 5, 60 * 60 * 1000, `e:${customerEmail.toLowerCase()}`),
      applyRateLimit(request, "shop_rc_cap_shop_5m", 15, 5 * 60 * 1000, `s:${shopId}`),
      applyRateLimit(request, "shop_rc_cap_shop_1h", 60, 60 * 60 * 1000, `s:${shopId}`),
    ])
    if (!emailCapRC.allowed) {
      console.warn(`[RC-SHOP-INIT] ❌ Atomic email cap hit for shop ${shopId}`)
      return NextResponse.json(
        { error: "Too many pending orders. Please complete or wait for existing orders to expire." },
        { status: 429 }
      )
    }
    if (!shop5mCapRC.allowed || !shop1hCapRC.allowed) {
      console.warn(`[RC-SHOP-INIT] ❌ Atomic shop cap hit (5m_allowed=${shop5mCapRC.allowed} 1h_allowed=${shop1hCapRC.allowed}) for shop ${shopId}`)
      return NextResponse.json(
        { error: "Too many pending orders for this shop. Please try again shortly." },
        { status: 429 }
      )
    }

    // DB-level flood guards — backup defence in case Upstash is unavailable.
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    const [{ count: pendingByEmail }, { count: pendingByShop5m }, { count: pendingByShop1h }] = await Promise.all([
      supabase
        .from("results_checker_orders")
        .select("id", { count: "exact", head: true })
        .eq("customer_email", customerEmail)
        .eq("status", "pending_payment")
        .gte("created_at", oneHourAgo),
      supabase
        .from("results_checker_orders")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", shopId)
        .eq("status", "pending_payment")
        .gte("created_at", fiveMinutesAgo),
      supabase
        .from("results_checker_orders")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", shopId)
        .eq("status", "pending_payment")
        .gte("created_at", oneHourAgo),
    ])

    if ((pendingByEmail ?? 0) >= 5) {
      return NextResponse.json(
        { error: "Too many pending orders. Please complete or wait for existing orders to expire." },
        { status: 429 }
      )
    }
    if ((pendingByShop5m ?? 0) >= 15 || (pendingByShop1h ?? 0) >= 60) {
      return NextResponse.json(
        { error: "Too many pending orders for this shop. Please try again shortly." },
        { status: 429 }
      )
    }

    const pricing = await calculateRCPrice({ examBoard, quantity, shopId })
    const referenceCode = generateRCReference()

    // Create pending order — do NOT reserve inventory yet (payment not confirmed)
    const { data: order, error: orderError } = await supabase
      .from("results_checker_orders")
      .insert([{
        reference_code: referenceCode,
        exam_board: examBoard,
        quantity,
        customer_name: customerName ?? "Guest",
        customer_email: customerEmail,
        customer_phone: customerPhone ?? null,
        unit_price: pricing.unitPrice,
        fee_amount: 0,
        total_paid: pricing.totalPaid,
        shop_id: shopId,
        merchant_commission: pricing.merchantCommission,
        status: "pending_payment",
        payment_status: "pending_payment",
      }])
      .select()
      .single()

    if (orderError || !order) {
      console.error("[RC-SHOP-INIT] Order creation error:", orderError)
      return NextResponse.json({ error: "Failed to initialize order" }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      orderId: order.id,
      totalPrice: pricing.totalPaid,
      reference: referenceCode,
    })

  } catch (error) {
    console.error("[RC-SHOP-INIT] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
