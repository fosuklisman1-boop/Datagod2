import { NextRequest, NextResponse } from "next/server"
import { initializePayment, chargeMobileMoney } from "@/lib/paystack"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"
import { applyRateLimit } from "@/lib/rate-limiter"
import { verifyShopSession } from "@/lib/shop-token"
import { isPhoneVerified } from "@/lib/storefront-otp"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// Ghana MoMo provider from phone prefix → Paystack provider code.
const MOMO_PREFIX: Record<string, "mtn" | "vod" | "tgo"> = {
  "024": "mtn", "025": "mtn", "053": "mtn", "054": "mtn", "055": "mtn", "059": "mtn",
  "020": "vod", "050": "vod",
  "026": "tgo", "027": "tgo", "056": "tgo", "057": "tgo",
}
function detectMomoProvider(phone: string): "mtn" | "vod" | "tgo" | null {
  const d = phone.replace(/\D/g, "")
  const local = d.startsWith("233") ? "0" + d.slice(3) : (d.startsWith("0") ? d : "0" + d)
  return MOMO_PREFIX[local.slice(0, 3)] ?? null
}

const ALLOWED_ORIGINS = [
  "https://www.datagod.store",
  "https://datagod.store",
  ...(process.env.NODE_ENV === "development" ? ["http://localhost:3000"] : []),
]

function getCorsHeaders(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
  }
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin")
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(origin) })
}

export async function POST(request: NextRequest) {
  try {
    // Rate limit: every payment-init = one Paystack checkout session = one
    // potential MoMo prompt to whatever number the attacker types. Tightened
    // aggressively to throttle prompt-spam to innocent third parties.
    // Per-IP: 3/min AND 30/hour (Cloudflare provides the real IP via cf-connecting-ip).
    const rlMinute = await applyRateLimit(request, "payments_initialize", 3, 60_000)
    if (!rlMinute.allowed) {
      return NextResponse.json(
        { error: "Too many payment requests. Please wait a moment." },
        { status: 429, headers: { "X-RateLimit-Reset": new Date(rlMinute.resetAt).toISOString() } }
      )
    }
    const rlHour = await applyRateLimit(request, "payments_initialize_hr", 30, 60 * 60 * 1000)
    if (!rlHour.allowed) {
      return NextResponse.json(
        { error: "Too many payment requests. Please try again later." },
        { status: 429, headers: { "X-RateLimit-Reset": new Date(rlHour.resetAt).toISOString() } }
      )
    }

    const body = await request.json()
    let { amount, email, shopId, orderId, shopSlug, type, planId, orderType, momoDirect, paymentPhone } = body

    // SECURITY: never trust client's shopId — resolve from slug. The slug is the
    // public identifier; the UUID is internal. Wallet topups and dealer upgrades
    // skip this (they don't pass shopSlug).
    if (shopSlug) {
      const { data: shopRow, error: shopErr } = await supabase
        .from("user_shops")
        .select("id")
        .eq("shop_slug", shopSlug)
        .single()
      if (shopErr || !shopRow) {
        console.warn(`[PAYMENT-INIT] ❌ Shop not found for slug=${shopSlug}`)
        return NextResponse.json({ error: "Shop not found" }, { status: 404 })
      }
      shopId = shopRow.id
    }

    // Extract userId from JWT (not from request body — prevents spoofing)
    let userId: string | undefined
    const authHeader = request.headers.get("Authorization")
    if (authHeader?.startsWith("Bearer ")) {
      const { data: { user } } = await supabase.auth.getUser(authHeader.substring(7))
      if (user) userId = user.id
    }

    console.log("[PAYMENT-INIT] Request received:", { userId, amount, orderType })

    // Cookie + slug-binding check for shop-order payments.
    // Look up the order's shop_id → shop's current slug → verify cookie matches.
    if (orderId) {
      // Per-ORDER init cap: a single order may be initialized at most twice
      // (initial attempt + one retry — covers the common MoMo "wrong PIN /
      // timeout, try again" case without enabling prompt amplification).
      // Without this, an attacker re-initializes one pending order repeatedly,
      // each call minting a new Paystack checkout = a new MoMo prompt to a new
      // victim number. Capping per orderId collapses that amplification.
      const perOrderCap = await applyRateLimit(request, "payment_init_order", 2, 60 * 60 * 1000, `o:${orderId}`)
      if (!perOrderCap.allowed) {
        console.warn(`[PAYMENT-INIT] ❌ Per-order init cap hit for orderId=${orderId}`)
        return NextResponse.json(
          { error: "This order has already been initialized for payment. Please use the existing payment link or place a new order." },
          { status: 429 }
        )
      }

      const shopCookie = request.cookies.get("__shop_sess")?.value
      if (!shopCookie) {
        console.warn(`[PAYMENT-INIT] ❌ Blocked: missing __shop_sess cookie for orderId=${orderId}`)
        return NextResponse.json({ error: "Invalid session. Please refresh the page and try again." }, { status: 403 })
      }

      // Determine which table the order lives in based on orderType, then resolve its shop slug
      const orderTable = orderType === "airtime" ? "airtime_orders"
        : orderType === "results_checker" ? "results_checker_orders"
        : "shop_orders"
      const { data: orderShopRef } = await supabase
        .from(orderTable)
        .select("shop_id")
        .eq("id", orderId)
        .single()
      if (!orderShopRef?.shop_id) {
        console.warn(`[PAYMENT-INIT] ❌ Order not found for cookie verification: orderId=${orderId} table=${orderTable}`)
        return NextResponse.json({ error: "Order not found" }, { status: 404 })
      }
      const { data: shopForCookie } = await supabase
        .from("user_shops")
        .select("shop_slug")
        .eq("id", orderShopRef.shop_id)
        .single()
      if (!shopForCookie?.shop_slug) {
        console.warn(`[PAYMENT-INIT] ❌ Shop not found for cookie verification: shop_id=${orderShopRef.shop_id}`)
        return NextResponse.json({ error: "Shop not found" }, { status: 404 })
      }

      const cookieCheck = verifyShopSession(shopCookie, shopForCookie.shop_slug)
      if (!cookieCheck.valid) {
        console.warn(`[PAYMENT-INIT] ❌ Invalid shop session cookie (${cookieCheck.reason}) for orderId=${orderId} expected_slug=${shopForCookie.shop_slug} secret_configured=${!!process.env.SHOP_TOKEN_SECRET}`)
        return NextResponse.json({ error: "Invalid session. Please refresh the page and try again." }, { status: 403 })
      }
      console.log(`[PAYMENT-INIT] ✓ Cookie valid for orderId=${orderId} slug=${shopForCookie.shop_slug}`)
    }

    // Validate input
    if (!email) {
      console.warn("[PAYMENT-INIT] Missing required fields")
      return NextResponse.json(
        { error: "Missing required fields: email" },
        { status: 400 }
      )
    }

    // Per-email payment-init cap: 5 per hour. Card-testers reusing an email get
    // throttled here; rotating emails still face the per-IP cap (6/min) + Cloudflare.
    const emailCap = await applyRateLimit(request, "payment_init_email", 5, 60 * 60 * 1000, `e:${String(email).toLowerCase()}`)
    if (!emailCap.allowed) {
      console.warn(`[PAYMENT-INIT] ❌ Per-email cap hit for ${String(email).slice(0, 40)}`)
      return NextResponse.json(
        { error: "Too many payment attempts. Please try again later." },
        { status: 429 }
      )
    }

    // Fetch feature toggles and fee settings early
    const { data: settings } = await supabase
      .from("app_settings")
      .select("paystack_fee_percentage, wallet_topups_enabled, upgrades_enabled")
      .single()

    // Fetch user role for admin bypass - check users table (source of truth)
    let isAdmin = false
    if (userId) {
      try {
        const { data: userData } = await supabase.from("users").select("role").eq("id", userId).single()
        isAdmin = userData?.role === 'admin'
      } catch (err) {
        console.warn(`[PAYMENT-INIT] Could not verify user status for ${userId}:`, err)
      }
    }

    // Airtime orders MUST have an orderId — prevents arbitrary-amount Paystack links
    // being generated by passing orderType:"airtime" with no orderId (bypasses auth + price check)
    if (orderType === "airtime" && !orderId) {
      console.warn("[PAYMENT-INIT] Blocked: airtime payment with no orderId")
      return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    }

    const isTopup = !orderId && type !== "dealer_upgrade" && orderType !== "airtime"
    const isUpgrade = type === "dealer_upgrade"

    // Wallet top-ups MUST have an authenticated user — otherwise the credit step
    // has no user_id to credit and the top-up gets permanently stuck.
    // This catches expired/missing JWTs before Paystack charges the user.
    if (isTopup && !userId) {
      console.warn("[PAYMENT-INIT] Blocked wallet top-up: no authenticated user (missing/expired JWT)")
      return NextResponse.json(
        { error: "You must be signed in to top up your wallet. Please refresh and try again." },
        { status: 401 }
      )
    }

    // Enforce Feature Availability Toggles
    if (isTopup && settings?.wallet_topups_enabled === false && !isAdmin) {
      console.warn(`[PAYMENT-INIT] Blocked Top Up for non-admin user ${userId} because feature is disabled.`)
      return NextResponse.json(
        { error: "Wallet top-ups are currently disabled by the administrator." },
        { status: 403 }
      )
    }

    if (isUpgrade && settings?.upgrades_enabled === false && !isAdmin) {
      console.warn(`[PAYMENT-INIT] Blocked Upgrade for non-admin user ${userId} because feature is disabled.`)
      return NextResponse.json(
        { error: "Rank upgrades are currently disabled by the administrator." },
        { status: 403 }
      )
    }

    // Block subscription cycling: refuse a new dealer upgrade payment if the
    // user already has an active subscription. Stops "subscribe → use →
    // cancel/chargeback → re-subscribe" abuse loops on the same account.
    // Admins bypass for support/testing purposes.
    if (isUpgrade && userId && !isAdmin) {
      const { data: activeSub } = await supabase
        .from("user_subscriptions")
        .select("id, end_date, status")
        .eq("user_id", userId)
        .eq("status", "active")
        .gt("end_date", new Date().toISOString())
        .maybeSingle()
      if (activeSub) {
        console.warn(`[PAYMENT-INIT] ❌ Duplicate subscription blocked for user ${userId} (active sub ${activeSub.id} until ${activeSub.end_date})`)
        return NextResponse.json(
          { error: "You already have an active subscription. Wait for it to expire before purchasing another." },
          { status: 409 }
        )
      }
    }

    let finalAmount = amount

    // SECURITY ENHANCEMENT: For shop orders, ignore client amount & fetch from DB
    if (orderId) {
      const table = orderType === "airtime" ? "airtime_orders" : orderType === "results_checker" ? "results_checker_orders" : "shop_orders"
      console.log(`[PAYMENT-INIT] ${orderType} order detected (${orderId}). Verifying price from database...`)

      const amountColumn = (orderType === "airtime" || orderType === "results_checker") ? "total_paid" : "total_price"
      // shop_orders uses order_status; airtime/results_checker use status
      const isShopOrder = orderType !== "airtime" && orderType !== "results_checker"
      const statusField = isShopOrder ? "order_status" : "status"
      const selectColumns = `${amountColumn}, ${statusField}, payment_status`
      const { data: orderData, error: orderError } = await supabase
        .from(table)
        .select(selectColumns)
        .eq("id", orderId)
        .single()

      if (orderError || !orderData) {
        console.error("[PAYMENT-INIT] ❌ Could not find order:", orderError)
        return NextResponse.json(
          { error: "Invalid order ID" },
          { status: 400 }
        )
      }

      // Reject any order that is no longer awaiting payment — blocks reuse of
      // expired/failed/already-paid order IDs across all order types.
      const orderStatus = (orderData as any)[statusField]
      const orderPaymentStatus = (orderData as any).payment_status
      const alreadyPaid = orderPaymentStatus === "completed"
      const notPayable = ["failed", "expired", "cancelled", "completed"].includes(orderStatus)

      if (alreadyPaid || notPayable) {
        console.warn(`[PAYMENT-INIT] ❌ Order ${orderId} (${orderType}) not payable — ${statusField}: ${orderStatus}, payment_status: ${orderPaymentStatus}`)
        return NextResponse.json(
          { error: "This order is no longer available for payment." },
          { status: 400 }
        )
      }

      // Override client amount with server-verified amount
      // Ensure we treat it as a number
      const verifiedAmount = Number((orderData as any)[amountColumn])

      if (isNaN(verifiedAmount) || verifiedAmount <= 0) {
        console.error("[PAYMENT-INIT] ❌ Invalid order price in DB:", (orderData as any)[amountColumn])
        return NextResponse.json(
          { error: "Invalid order configuration" },
          { status: 500 }
        )
      }

      console.log(`[PAYMENT-INIT] ✓ Price verified. Client sent: ${amount}, DB has: ${verifiedAmount}. Enforcing DB value.`)
      finalAmount = verifiedAmount
    } else if (type === "dealer_upgrade" && planId) {
      console.log(`[PAYMENT-INIT] Dealer Upgrade detected. Verifying plan ${planId}...`)
      const { data: plan, error: planError } = await supabase
        .from("subscription_plans")
        .select("price")
        .eq("id", planId)
        .eq("is_active", true)
        .single()

      if (planError || !plan) {
        console.error("[PAYMENT-INIT] ❌ Could not find active plan:", planError)
        return NextResponse.json({ error: "Invalid subscription plan" }, { status: 400 })
      }

      finalAmount = Number(plan.price)
      console.log(`[PAYMENT-INIT] ✓ Plan price verified: ${finalAmount}`)
    } else {
      // For Wallet Top-up (no orderId), we require amount with reasonable bounds
      if (!amount || typeof amount !== "number" || amount <= 0) {
        console.warn("[PAYMENT-INIT] Invalid amount for top-up:", amount)
        return NextResponse.json(
          { error: "Amount must be a positive number" },
          { status: 400 }
        )
      }
      const MAX_TOPUP = isAdmin ? 100_000 : 10_000
      if (amount > MAX_TOPUP) {
        console.warn(`[PAYMENT-INIT] Top-up amount ${amount} exceeds max ${MAX_TOPUP} for user ${userId}`)
        return NextResponse.json(
          { error: `Maximum top-up amount is GHS ${MAX_TOPUP.toLocaleString()}` },
          { status: 400 }
        )
      }
    }



    // Generate unique reference
    const reference = `WALLET-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`

    // For airtime orders, we remove the additional Paystack fee as requested
    // The platform base fee is expected to absorb the payment processor cost.
    const isAirtime = orderType === "airtime"
    const paystackFeePercentage = isAirtime ? 0 : (settings?.paystack_fee_percentage || 3.0) / 100
    
    // Use finalAmount (verified) for calculation
    const paystackFee = Math.round(finalAmount * paystackFeePercentage * 100) / 100
    const totalAmount = finalAmount + paystackFee

    console.log("[PAYMENT-INIT] Fee Calculation:")
    console.log("  Original Amount:", finalAmount)
    console.log(`  Paystack Fee (${paystackFeePercentage * 100}%):`, paystackFee)
    console.log("  Total Amount:", totalAmount)

    // Store payment record with total amount (including fee)
    console.log("[PAYMENT-INIT] Creating payment record...")
    const { data: paymentData, error: paymentError } = await supabase
      .from("wallet_payments")
      .insert([
        {
          user_id: userId,
          shop_id: shopId || null,
          order_id: orderId || null,
          order_type: type === "dealer_upgrade" ? "dealer_upgrade" : (orderType || "data"),
          amount: parseFloat(totalAmount.toString()),
          fee: parseFloat(paystackFee.toString()),
          reference,
          status: "pending",
          payment_method: "paystack",
          created_at: new Date().toISOString(),
        },
      ])
      .select()

    if (paymentError || !paymentData || paymentData.length === 0) {
      console.error("[PAYMENT-INIT] Database error:", paymentError)
      console.error("[PAYMENT-INIT] Error code:", paymentError?.code)
      console.error("[PAYMENT-INIT] Error message:", paymentError?.message)
      console.error("[PAYMENT-INIT] Error details:", JSON.stringify(paymentError, null, 2))
      throw new Error(`Failed to create payment record: ${paymentError?.message || "Unknown error"}`)
    }

    console.log("[PAYMENT-INIT] ✓ Payment record created:", paymentData[0].id)

    // Initialize Paystack with redirect URL
    console.log("[PAYMENT-INIT] Calling Paystack...")
    const isDealerUpgradePayment = type === "dealer_upgrade"
    const confirmationPath =
      orderType === "airtime" ? "airtime/confirmation" :
      orderType === "results_checker" ? "results-checker/confirmation" :
      `order-confirmation/${orderId}`
    const appendOrderId = orderType === "airtime" || orderType === "results_checker"
    // SECURITY: Never use request.headers.get("origin") — it's attacker-controlled
    // and would let a crafted request steer Paystack's post-payment redirect to a
    // phishing site. Use server env exclusively.
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL
      ? process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000"
    let redirectUrl: string
    if (shopId && orderId && shopSlug) {
      redirectUrl = `${baseUrl}/shop/${shopSlug}/${confirmationPath}?reference=${reference}${appendOrderId ? `&orderId=${orderId}` : ""}`
    } else if (isDealerUpgradePayment) {
      redirectUrl = `${baseUrl}/dashboard/upgrade?reference=${reference}`
    } else {
      redirectUrl = `${baseUrl}/dashboard/wallet?reference=${reference}`
    }
    console.log("[PAYMENT-INIT] Redirect URL:", redirectUrl)

    const paymentMetadata = {
      userId,
      shopId: shopId || null,
      type: type || (orderType === "airtime" ? "airtime_purchase" : "shop_order"),
      planId: planId || null,
      orderId: orderId || null,
      orderType: orderType || "data",
      originalAmount: finalAmount,
      paystackFee: paystackFee,
    }

    // Origin tag stamped into Paystack metadata/custom_fields. Lets us read, on
    // the Paystack dashboard, exactly which backend path produced any txn — and
    // flag any txn lacking the "datagod_backend" source as not ours.
    const paymentChannel =
      type === "dealer_upgrade" ? "dealer_upgrade"
        : orderType === "airtime" ? "shop_airtime"
        : orderType === "results_checker" ? "shop_results_checker"
        : orderId ? "shop_data"
        : "wallet_topup"

    // ── Direct MoMo charge path ──────────────────────────────────────────────
    // When the client requests momoDirect (used while the checkout OTP gate is
    // on), we charge a SERVER-SPECIFIED, OTP-VERIFIED MoMo number directly via
    // Paystack /charge — no hosted redirect page where a random victim number
    // could be typed. The prompt can ONLY go to the verified number. The
    // existing charge.success webhook resolves `reference` → wallet_payments →
    // order exactly as the redirect flow does, so fulfillment is unchanged.
    if (momoDirect) {
      if (!orderId) {
        return NextResponse.json({ error: "Direct MoMo charge requires an order." }, { status: 400 })
      }
      const payPhone = String(paymentPhone || "").trim()
      const provider = detectMomoProvider(payPhone)
      if (!provider) {
        return NextResponse.json({ error: "Could not detect mobile money network from the payment number." }, { status: 400 })
      }
      // The payment number MUST be OTP-verified (server-enforced — the client
      // can't fake this; verification lives in phone_otp_verifications).
      const payVerified = await isPhoneVerified(payPhone)
      if (!payVerified) {
        return NextResponse.json(
          { error: "Please verify your payment number to continue.", code: "OTP_REQUIRED" },
          { status: 403 }
        )
      }

      const charge = await chargeMobileMoney({
        email,
        amount: totalAmount,
        phone: payPhone,
        provider,
        reference,
        metadata: paymentMetadata,
        channel: paymentChannel,
      })

      const corsHeaders = getCorsHeaders(request.headers.get("origin"))
      const resp = NextResponse.json({
        success: true,
        momoDirect: true,
        reference,
        status: charge.status, // usually "pay_offline" / "send_otp" / "pending"
        paymentId: paymentData[0].id,
      })
      Object.entries(corsHeaders).forEach(([k, v]) => resp.headers.set(k, v))
      resp.headers.set("Cache-Control", "no-cache, no-store, must-revalidate")
      return resp
    }

    const paymentResult = await initializePayment({
      email,
      amount: totalAmount,
      reference,
      redirectUrl,
      metadata: paymentMetadata,
      channel: paymentChannel,
      // Card channel can be disabled platform-wide during a card-testing attack
      // by setting PAYMENT_CARD_DISABLED=true. Ghana is mobile-money-first, so
      // dropping card barely affects legit revenue while killing card-testing.
      channels: process.env.PAYMENT_CARD_DISABLED === "true"
        ? ["mobile_money", "bank_transfer"]
        : ["card", "mobile_money", "bank_transfer"],
    })

    console.log("[PAYMENT-INIT] ✓ Success")

    // Track payment attempt in payment_attempts table (non-blocking)
    supabase
      .from("payment_attempts")
      .insert([{
        user_id: userId,
        reference,
        amount: finalAmount,
        fee: paystackFee,
        email,
        status: "pending",
        payment_type: type === "dealer_upgrade" ? "dealer_upgrade" : (orderType === "airtime" ? "shop_airtime" : (orderType === "results_checker" ? "results_checker" : (shopId ? "shop_order" : "wallet_topup"))),
        shop_id: shopId || null,
        order_id: orderId || null,
        created_at: new Date().toISOString(),
      }])
      .then(({ error }) => {
        if (error) {
          console.warn("[PAYMENT-INIT] Failed to create payment attempt record:", error.message)
        } else {
          console.log("[PAYMENT-INIT] ✓ Payment attempt tracked")
        }
      })

    const corsHeaders = getCorsHeaders(request.headers.get("origin"))
    const response = NextResponse.json({
      success: true,
      authorizationUrl: paymentResult.authorizationUrl,
      accessCode: paymentResult.accessCode,
      reference: paymentResult.reference,
      paymentId: paymentData[0].id,
    })

    Object.entries(corsHeaders).forEach(([k, v]) => response.headers.set(k, v))
    response.headers.set("Cache-Control", "no-cache, no-store, must-revalidate")
    response.headers.set("Pragma", "no-cache")
    response.headers.set("Expires", "0")

    return response
  } catch (error) {
    console.error("[PAYMENT-INIT] ✗ Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to initialize payment" },
      { status: 500 }
    )
  }
}
