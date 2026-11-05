import { NextRequest, NextResponse } from "next/server"
import { checkUpgradeInitRequest } from "@/lib/dealer-upgrade-payment"
import { initializePayment, chargeMobileMoney } from "@/lib/paystack"
import { createClient } from "@supabase/supabase-js"
import { shopHandleOrFilter } from "@/lib/shop-handle"
import crypto from "crypto"
import { applyRateLimit } from "@/lib/rate-limiter"
import { verifyShopSession } from "@/lib/shop-token"
import { isPhoneOtpVerified, isWalletOtpRequired, isStorefrontOtpRequired, isStorefrontDirectChargeEnabled, isWalletDirectChargeEnabled, isDashboardDirectChargeEnabled } from "@/lib/storefront-otp"
import { logSecurityEvent } from "@/lib/security-log"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { resolveTrustedBaseUrl } from "@/lib/custom-domain-lookup"
import { recordPayerPhone } from "@/lib/refunds/payer-phone"
import {
  isStorefrontOrderType, STOREFRONT_ORDER_TABLE, newPaystackReference, extraPaystackFeeRate, checkCommissionPayable,
  STOREFRONT_PAYMENT_CHANNEL, STOREFRONT_PAYMENT_PURPOSE, STOREFRONT_CONFIRMATION_PATH, DIRECT_CHARGE_OFF, type CommissionPrice,
} from "@/lib/storefront-commission/payment"
import { AIRTIME_REPRICE_SPEC, commissionRepriceSpec, priceOrderForGateway, type RepriceSpec } from "@/lib/storefront-commission/reprice"
import { FallbackRefusedError, HostedStartError, resolveSurfaceGateway, startHostedPayment, startMomoCharge } from "@/lib/payment-gateway/start"
import { getSurfaceConfig } from "@/lib/payment-gateway/read-config"
import type { FeeBearer, Gateway } from "@/lib/payment-gateway/config"
import { initializeFee, initializeSurface, isVerifiedWebPayer, momoPhoneText, pickHubtelReplay, HUBTEL_REPLAY_LOOKBACK_MS, type OpenAttemptReplayRow } from "@/lib/payment-gateway/initialize-gateway"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import { sendThrottledAlert } from "@/lib/hubtel-pay/alert-throttle"

// A Hubtel start awaits the relay.
export const maxDuration = 60

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

/**
 * wallet_payments.payment_method must name the gateway that actually took the payment. A fallback to Paystack fixes
 * its row in onFallback; what's left is the config changing between resolving and starting. The row is fixed right
 * after the start returns. The money has already moved on, so a failed fix can't refuse: it alerts the admins.
 */
async function syncPaymentMethod(reference: string, written: Gateway, used: Gateway): Promise<void> {
  if (written === used) return
  let problem: string | null = null
  try {
    const { data, error } = await supabase.from("wallet_payments").update({ payment_method: used }).eq("reference", reference).select("id")
    if (error) problem = error.message
    else if (!data?.length) problem = "no row changed"
  } catch (e) {
    problem = e instanceof Error ? e.message : "unknown error"
  }
  if (!problem) return
  console.error(`[PAYMENT-INIT] ❌ Could not set payment_method=${used} for ${reference}:`, problem)
  await sendThrottledAlert(supabase, `Payment ${reference} was taken by ${used}, but its record could not be updated. Check it by hand.`, {
    key: "last_payment_method_sync_alert", type: "hubtel_payment_start", description: "Payment method correction alert throttle",
    windowMs: 60 * 60 * 1000, logPrefix: "[PAYMENT-INIT]",
  })
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
    // Storefront Utility Bill / Standard Bundle order (internal codes cs_bill / cs_bundle), else null.
    const storefrontType = isStorefrontOrderType(orderType) ? orderType : null

    // SECURITY: never trust client's shopId — resolve from slug. The slug is the
    // public identifier; the UUID is internal. Wallet topups and dealer upgrades
    // skip this (they don't pass shopSlug).
    if (shopSlug) {
      // Match either the clean subdomain or the legacy shop_slug — on a subdomain
      // storefront this value is the subdomain (see middleware rewrite).
      const { data: shopRow, error: shopErr } = await supabase
        .from("user_shops")
        .select("id")
        .or(shopHandleOrFilter(shopSlug))
        .eq("is_active", true)
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

    // Client IP — used for rate-limit identity, Paystack metadata, and security
    // logs. Computed early so it's available throughout the handler.
    const clientIp =
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-real-ip") ||
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      undefined

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

      // Storefront bill/bundle orders: refuse a second payment start while an earlier one for the same
      // order is still pending and recent — otherwise a buyer who closes the sheet and taps Pay again
      // can approve two live MoMo prompts and pay twice. After the window, a retry is allowed.
      if (storefrontType) {
        const since = new Date(Date.now() - 3 * 60 * 1000).toISOString()
        const { data: livePayment, error: liveErr } = await supabase
          .from("wallet_payments")
          .select("id")
          .eq("order_id", orderId)
          .eq("status", "pending")
          .gte("created_at", since)
          .limit(1)
        if (liveErr) {
          console.error("[PAYMENT-INIT] live-payment check failed:", liveErr.message)
          return NextResponse.json({ error: "Could not start the payment. Please try again." }, { status: 503 })
        }
        if (livePayment && livePayment.length > 0) {
          return NextResponse.json(
            {
              error: "A payment for this order is still waiting for approval on your phone. Approve it, or wait 3 minutes and try again.",
              code: "PAYMENT_IN_PROGRESS",
            },
            { status: 409 }
          )
        }
      }

      // __shop_sess cookie binding — DISABLED by default (was blocking real
      // visitors with "Invalid session"). Re-enable via SHOP_SESSION_ENFORCED=true.
      if (process.env.SHOP_SESSION_ENFORCED === "true") {
      const shopCookie = request.cookies.get("__shop_sess")?.value
      if (!shopCookie) {
        console.warn(`[PAYMENT-INIT] ❌ Blocked: missing __shop_sess cookie for orderId=${orderId}`)
        return NextResponse.json({ error: "Invalid session. Please refresh the page and try again." }, { status: 403 })
      }

      // Determine which table the order lives in based on orderType, then resolve its shop slug
      const orderTable = storefrontType ? STOREFRONT_ORDER_TABLE[storefrontType]
        : orderType === "airtime" ? "airtime_orders"
        : orderType === "results_checker" ? "results_checker_orders"
        : orderType === "results_check_service" ? "results_check_requests"
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
    }

    // Validate input (storefront commission orders pay with the order's buyer email, read from the DB below)
    if (!email && !storefrontType) {
      console.warn("[PAYMENT-INIT] Missing required fields")
      return NextResponse.json(
        { error: "Missing required fields: email" },
        { status: 400 }
      )
    }

    // Per-email payment-init cap: 5 per hour. Card-testers reusing an email get
    // throttled here; rotating emails still face the per-IP cap (6/min) + Cloudflare.
    // (Storefront commission orders apply this cap to the order's buyer email after the DB read below.)
    const emailCap = storefrontType
      ? { allowed: true }
      : await applyRateLimit(request, "payment_init_email", 5, 60 * 60 * 1000, `e:${String(email).toLowerCase()}`)
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
      .is("key", null)
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
    // Commission orders likewise need an orderId; storefront rows also need the shop (resolved from the slug above),
    // which is enforced after the row is read below (bot rows have no storefront slug).
    if (storefrontType && (!orderId || type)) {
      console.warn(`[PAYMENT-INIT] Blocked: ${storefrontType} payment without orderId/shopSlug`)
      return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    }

    const isTopup = !orderId && type !== "dealer_upgrade" && orderType !== "airtime"
    const isUpgrade = type === "dealer_upgrade"

    const upgradeCheck = checkUpgradeInitRequest({ type, orderType, orderId, planId, userId })
    if (!upgradeCheck.ok) {
      logSecurityEvent("dealer_upgrade_init_refused", { reason: upgradeCheck.error, hasOrderId: !!orderId, userId, ip: clientIp })
      return NextResponse.json({ error: upgradeCheck.error }, { status: upgradeCheck.status })
    }

    // Phone gate (account holder's own money paths only). Wallet top-up and dealer
    // upgrade move the LOGGED-IN user's money — block them for an unverified account.
    // Storefront customer payments (orderId / shopSlug) are gated by the separate
    // storefront OTP, not this account gate, so they're excluded here. Admins bypass.
    if ((isTopup || isUpgrade) && userId && !isAdmin) {
      const phoneGuard = await checkPhoneVerified(supabase, userId)
      if (!phoneGuard.allowed) {
        return NextResponse.json({ error: phoneGuard.error }, { status: 403 })
      }
    }

    // Gate state — OTP and direct-charge are now INDEPENDENT toggles per surface.
    //   • OTP gate         → must the MoMo number be SMS-OTP verified?
    //   • direct-charge gate → is payment collected via the on-page direct MoMo
    //                          charge (momoDirect) vs the hosted Paystack redirect?
    // Surfaces: storefront shop orders (orderId/shopSlug) vs the order-free paths
    // (wallet top-up / dealer upgrade). The hosted mobile_money strip below now
    // keys off the DIRECT-CHARGE gate (a hosted init when direct charge is the
    // legit path = a bypass), not the OTP gate.
    const isShopOrderSurface = !!orderId
    const isWalletSurface = isTopup || isUpgrade
    const [walletGateOn, walletDirectOn, dashboardDirectOn, storefrontGateOn, storefrontDirectOn] = await Promise.all([
      isWalletOtpRequired(),
      isWalletDirectChargeEnabled(),
      isDashboardDirectChargeEnabled(),
      isStorefrontOtpRequired(),
      isStorefrontDirectChargeEnabled(),
    ])

    // Per-surface flags for the request in hand.
    const surfaceOtpOn = isShopOrderSurface ? storefrontGateOn : isWalletSurface ? walletGateOn : false
    const surfaceDirectOn = isShopOrderSurface
      ? storefrontDirectOn
      : isUpgrade
        ? dashboardDirectOn
        : isTopup
          ? walletDirectOn
          : false

    // Order-free per-user burst cap: keep it active when EITHER wallet gate (OTP
    // or direct charge) is on. Admins bypass for support/testing.
    if ((walletGateOn || walletDirectOn || dashboardDirectOn) && (isTopup || isUpgrade) && !isAdmin && userId) {
      const perUser = await applyRateLimit(request, "payment_init_topup_user", 5, 30 * 60 * 1000, `tu:${userId}`)
      if (!perUser.allowed) {
        logSecurityEvent("wallet_topup_user_cap", { channel: type === "dealer_upgrade" ? "dealer_upgrade" : "wallet_topup", userId, email, ip: clientIp })
        return NextResponse.json(
          { error: "Too many payment attempts. Please try again later." },
          { status: 429 }
        )
      }
    }

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
    let recipient: string | undefined // product beneficiary (data/airtime recipient) for metadata
    // A channel 'bots' commission order (USSD / WhatsApp bots): no storefront slug, neutral payer email.
    let botOrder = false
    // An order whose stored price has the payment fee inside it (storefront commission: paid_amount; storefront
    // cashback airtime: total_paid), so that price moves with the gateway.
    let movablePrice: { spec: RepriceSpec; price: CommissionPrice } | null = null

    // Commission order: amount = paid_amount from the DB (the payment fee is already inside it), and only a row that
    // is still pending AND unpaid. Storefront rows: this shop's row, payer email = the buyer's. Bot rows: payer email =
    // the buyer's if any, else a neutral fallback (see checkCommissionPayable).
    if (orderId && storefrontType) {
      const { data: csRow, error: csErr } = await supabase
        .from(STOREFRONT_ORDER_TABLE[storefrontType])
        .select("channel, shop_id, status, payment_status, paid_amount, payment_fee_amount, buyer_email, buyer_phone")
        .eq("id", orderId)
        .maybeSingle()
      if (csErr) console.error("[PAYMENT-INIT] ❌ Could not read storefront order:", csErr)
      if (!shopSlug && (csErr || (csRow as { channel?: string } | null)?.channel !== "bots")) {
        console.warn(`[PAYMENT-INIT] Blocked: ${storefrontType} payment without orderId/shopSlug`)
        return NextResponse.json({ error: "Invalid request" }, { status: 400 })
      }
      const payable = checkCommissionPayable(csErr ? null : csRow, shopSlug ? shopId : null)
      if (!payable.ok) {
        console.warn(`[PAYMENT-INIT] ❌ Storefront order ${orderId} (${storefrontType}) not payable: ${payable.error}`)
        return NextResponse.json({ error: payable.error }, { status: payable.status })
      }
      // Per-payer payment-init cap (same budget as above): the order's buyer email (storefront) or buyer phone (bots,
      // whose fallback email is shared), never the client's.
      const csEmailCap = await applyRateLimit(request, "payment_init_email", 5, 60 * 60 * 1000, payable.capKey)
      if (!csEmailCap.allowed) {
        console.warn(`[PAYMENT-INIT] ❌ Per-email cap hit for storefront order ${orderId}`)
        return NextResponse.json({ error: "Too many payment attempts. Please try again later." }, { status: 429 })
      }
      finalAmount = payable.amount
      email = payable.email
      shopId = payable.shopId
      botOrder = payable.bot
      if (!payable.bot && storefrontType) {
        const recordedFee = (csRow as { payment_fee_amount?: number | string | null } | null)?.payment_fee_amount
        movablePrice = { spec: commissionRepriceSpec(storefrontType), price: { paid: payable.amount, fee: recordedFee === null ? null : Number(recordedFee ?? 0) } }
      }
    } else if (orderId) {
      // SECURITY ENHANCEMENT: For shop orders, ignore client amount & fetch from DB
      const table = orderType === "airtime" ? "airtime_orders"
        : orderType === "results_checker" ? "results_checker_orders"
        : orderType === "results_check_service" ? "results_check_requests"
        : "shop_orders"
      console.log(`[PAYMENT-INIT] ${orderType} order detected (${orderId}). Verifying price from database...`)

      const amountColumn = orderType === "results_check_service" ? "fee"
        : (orderType === "airtime" || orderType === "results_checker") ? "total_paid"
        : "total_price"
      // shop_orders uses order_status; airtime/results_checker/results_check_service use status
      const isShopOrder = orderType !== "airtime" && orderType !== "results_checker" && orderType !== "results_check_service"
      const statusField = isShopOrder ? "order_status" : "status"
      // Beneficiary column differs by table (airtime = beneficiary_phone, results_check_service = phone_number).
      const phoneColumn = orderType === "airtime" ? "beneficiary_phone"
        : orderType === "results_check_service" ? "phone_number"
        : "customer_phone"
      // Airtime also reads its cashback snapshot: only a cashback order has a payment fee inside total_paid.
      const selectColumns = `${amountColumn}, ${statusField}, payment_status, ${phoneColumn}${orderType === "airtime" ? ", payment_fee_amount, cashback_rate" : ""}`
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
        || (orderType === "results_check_service" && orderPaymentStatus === "paid")
      const notPayable = ["failed", "expired", "cancelled", "completed"].includes(orderStatus)

      if (alreadyPaid || notPayable) {
        console.warn(`[PAYMENT-INIT] ❌ Order ${orderId} (${orderType}) not payable — ${statusField}: ${orderStatus}, payment_status: ${orderPaymentStatus}`)
        return NextResponse.json(
          { error: "This order is no longer available for payment." },
          { status: 400 }
        )
      }

      // Beneficiary number (for the Paystack "Recipient" custom field).
      recipient = (orderData as any)[phoneColumn] || undefined

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
      // A legacy airtime order (no cashback snapshot) has no payment fee in total_paid: its fee_amount is margin.
      const cashbackAirtime = orderType === "airtime" && (orderData as any).cashback_rate !== null && (orderData as any).cashback_rate !== undefined
      if (cashbackAirtime) {
        const recordedFee = (orderData as any).payment_fee_amount
        movablePrice = { spec: AIRTIME_REPRICE_SPEC, price: { paid: verifiedAmount, fee: recordedFee === null ? null : Number(recordedFee ?? 0) } }
      }
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
      const MIN_TOPUP = 5 // GHS 5.00 — must match the frontend minimum
      if (amount < MIN_TOPUP) {
        console.warn(`[PAYMENT-INIT] Top-up amount ${amount} below minimum ${MIN_TOPUP}`)
        return NextResponse.json(
          { error: "Minimum top-up amount is GHS 5.00" },
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



    // ── Gateway choice (Paystack or Hubtel) ─────────────────────────────────
    // Only server config decides: any gateway / mode / feeBearer in the body is ignored. Resolved before the fee and
    // the payment row, because a Hubtel payment carries no Paystack fee. A request that maps to no surface (bot
    // commission rows, wired separately) keeps today's Paystack path exactly. Every order here was checked payable above.
    const gatewaySurface = initializeSurface({ storefrontType, botOrder, orderId, orderType, isTopup, isUpgrade })
    // When direct charge is the legit path, Paystack's hosted page has MoMo stripped (below). Hubtel's page can't strip
    // MoMo, so such a hosted request stays on Paystack.
    const hostedMomoStripped = !momoDirect && !isAdmin &&
      ((surfaceDirectOn && (isTopup || isUpgrade)) || (storefrontDirectOn && !!orderId))
    // A direct charge only runs when its gate is on (or for an admin); otherwise it is refused below, as today.
    // Canonicalised once, here: Hubtel gets this form. A number with none is "not Hubtel", so it carries the standard
    // Paystack fee from the start. The Paystack path keeps the raw value, as today.
    const canonicalPhone = momoDirect ? normalizeGhanaPhone(momoPhoneText(paymentPhone)) : null
    const directRuns = !!momoDirect && (surfaceDirectOn || isAdmin) && !!canonicalPhone && detectMomoProvider(canonicalPhone) !== null
    let gateway: Gateway = "paystack"
    let feeBearer: FeeBearer = "customer"
    if (gatewaySurface) {
      // Hubtel if the payer is verified; the direct check below decides that.
      const potential = await resolveSurfaceGateway(gatewaySurface, { verifiedPayer: true, amount: finalAmount })
      feeBearer = potential.feeBearer
      if (potential.gateway === "hubtel" && !hostedMomoStripped && (!momoDirect || directRuns)) {
        if (momoDirect && canonicalPhone) {
          // No unsolicited prompts (Hubtel's rule): a verified number is required even when the surface's OTP gate is
          // off, for admins too. Same answer as the OTP gate gives, before anything is written. When that gate is on,
          // it wants a real OTP, so an account's own verified number alone can't pass it further down with a row left behind.
          const verified = await isVerifiedWebPayer(canonicalPhone, {
            isPhoneOtpVerified,
            ownVerifiedPhone: async () => {
              if (!userId) return null
              const { data, error } = await supabase.from("users").select("phone_number, phone_verified").eq("id", userId).single()
              if (error || !data?.phone_verified) return null
              return (data.phone_number as string | null) ?? null
            },
          })
          const otpGatePassed = !surfaceOtpOn || isAdmin || await isPhoneOtpVerified(canonicalPhone)
          if (!verified || !otpGatePassed) {
            logSecurityEvent("momodirect_unverified_payment_number", {
              channel: "hubtel_direct", ip: clientIp, email, paymentPhone: canonicalPhone, orderId: orderId || null,
            })
            return NextResponse.json(
              { error: "Please verify your payment number to continue.", code: "OTP_REQUIRED" },
              { status: 403 }
            )
          }
          // Hubtel direct always takes the per-phone cap, OTP gate on or off and for admins too, keyed on the canonical
          // number so a reformatted number can't get a fresh budget. Checked before anything is written.
          const hubtelPhoneCap = await applyRateLimit(request, "momodirect_phone", 3, 60 * 60 * 1000, `mp:${canonicalPhone}`)
          if (!hubtelPhoneCap.allowed) {
            logSecurityEvent("momodirect_phone_cap", {
              channel: "hubtel_direct", ip: clientIp, email, paymentPhone: canonicalPhone, orderId: orderId || null,
            })
            return NextResponse.json(
              { error: "Too many payment attempts for this number. Please try again later." },
              { status: 429, headers: { "X-RateLimit-Reset": new Date(hubtelPhoneCap.resetAt).toISOString() } }
            )
          }
        }
        gateway = "hubtel"
      }
    }

    // R2: an order whose Hubtel attempt is still live (pending in the last 15 minutes, or an attempt that still holds
    // the order: see pickHubtelReplay) reuses that attempt's reference, so the wrapper's one-attempt-per-order rule
    // applies (no second prompt / the same link). Paystack rows replay nothing, as today; but a live Hubtel attempt is
    // never joined by a Paystack one.
    let replay: { id: string; reference: string } | null = null
    if (gatewaySurface && orderId) {
      const { data: liveRows, error: liveErr } = await supabase
        .from("wallet_payments")
        .select("id, reference, payment_method, status, created_at")
        .eq("order_id", orderId)
        .eq("status", "pending")
        .eq("payment_method", "hubtel")
        .gte("created_at", new Date(Date.now() - HUBTEL_REPLAY_LOOKBACK_MS).toISOString())
        .order("created_at", { ascending: false })
        .limit(5)
      let openAttempts: OpenAttemptReplayRow[] = []
      const liveReferences = (liveRows ?? []).map((r) => r.reference).filter(Boolean)
      if (!liveErr && liveReferences.length > 0) {
        const { data: attempts, error: attemptsErr } = await supabase
          .from("hubtel_payments")
          .select("internal_reference, expires_at, status, mode, checkout_url")
          .in("internal_reference", liveReferences)
          .in("status", ["pending", "confirming"])
        if (attemptsErr) {
          // These rows may have a live attempt behind them, whatever the surface says now: no fresh reference, no Paystack.
          console.error("[PAYMENT-INIT] Hubtel attempt lookup failed:", attemptsErr.message)
          return NextResponse.json({ error: "Could not start the payment. Please try again." }, { status: 503 })
        }
        openAttempts = attempts ?? []
      }
      if (liveErr) {
        console.error("[PAYMENT-INIT] Hubtel replay lookup failed:", liveErr.message)
        // A live attempt can't be ruled out, so no fresh reference. A surface on Paystack proceeds as today.
        if (gateway === "hubtel" || (await getSurfaceConfig(gatewaySurface)).gateway === "hubtel") {
          return NextResponse.json({ error: "Could not start the payment. Please try again." }, { status: 503 })
        }
      } else {
        replay = pickHubtelReplay(liveRows, Date.now(), openAttempts)
        if (replay && gateway !== "hubtel") {
          return NextResponse.json(
            {
              error: "A payment for this order is still in progress. Finish it, or try again a little later.",
              code: "PAYMENT_IN_PROGRESS",
            },
            { status: 409 }
          )
        }
      }
    }

    // The gateway is settled and the order isn't held by a live attempt, so its price can match: confirm checks
    // the stored price, so nothing is charged unless the two agree.
    if (movablePrice && gatewaySurface) {
      const priced = await priceOrderForGateway(supabase, movablePrice.spec, orderId, movablePrice.price, gateway === "hubtel" || feeBearer === "merchant")
      if (!priced.ok) return NextResponse.json({ error: "Could not start the payment. Please try again.", code: "try_again" }, { status: 503 })
      movablePrice.price = priced.price
      finalAmount = priced.price.paid
    }

    // Generate unique reference
    // Storefront commission orders use an opaque 32-hex reference (never the BILL-/SB- order code).
    const reference = replay
      ? replay.reference
      : storefrontType
        ? newPaystackReference()
        : `WALLET-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`

    // For airtime orders, we remove the additional Paystack fee as requested
    // The platform base fee is expected to absorb the payment processor cost.
    // Storefront commission orders add none either: their payment fee is already inside paid_amount.
    const paystackFeePercentage = extraPaystackFeeRate(orderType, settings?.paystack_fee_percentage)

    // Use finalAmount (verified) for calculation. Hubtel, or a merchant-borne fee, adds none.
    const standardFee = Math.round(finalAmount * paystackFeePercentage * 100) / 100
    let paystackFee = initializeFee({ surface: gatewaySurface, gateway, feeBearer, standardFee })
    const totalAmount = finalAmount + paystackFee

    console.log("[PAYMENT-INIT] Fee Calculation:")
    console.log("  Original Amount:", finalAmount)
    console.log(`  Paystack Fee (${paystackFeePercentage * 100}%):`, paystackFee)
    console.log("  Total Amount:", totalAmount)

    // Store payment record with total amount (including fee). A replayed Hubtel attempt already has its row.
    let paymentId: string
    if (replay) {
      paymentId = replay.id
      console.log("[PAYMENT-INIT] ✓ Replaying live Hubtel payment record:", paymentId)
    } else {
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
            // The resolved gateway; fixed after the start if the payment ended on the other one (syncPaymentMethod).
            payment_method: gateway,
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

      paymentId = paymentData[0].id
      console.log("[PAYMENT-INIT] ✓ Payment record created:", paymentId)
    }

    // Initialize Paystack with redirect URL
    console.log("[PAYMENT-INIT] Calling Paystack...")
    const isDealerUpgradePayment = type === "dealer_upgrade"
    const confirmationPath =
      storefrontType ? STOREFRONT_CONFIRMATION_PATH :
      orderType === "airtime" ? "airtime/confirmation" :
      orderType === "results_checker" ? "results-checker/confirmation" :
      orderType === "results_check_service" ? "results-check/confirmation" :
      `order-confirmation/${orderId}`
    const appendOrderId = !!storefrontType || orderType === "airtime" || orderType === "results_checker" || orderType === "results_check_service"
    // See resolveTrustedBaseUrl's doc comment for why this is safe against
    // the phishing-redirect risk a raw Origin/Host trust would otherwise carry.
    const baseUrl = await resolveTrustedBaseUrl(request.headers.get("host"))
    let redirectUrl: string
    if (shopId && orderId && shopSlug) {
      redirectUrl = `${baseUrl}/shop/${shopSlug}/${confirmationPath}?reference=${reference}${appendOrderId ? `&orderId=${orderId}` : ""}`
    } else if (botOrder) {
      // Bot orders: the buyer is told the result in the bot; the hosted page just returns to the site (no product words).
      redirectUrl = `${baseUrl}/?reference=${reference}`
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
      // Storefront commission orders: a neutral label (cs_bill / cs_bundle stay internal, in wallet_payments.order_type,
      // which the webhook and verify branch on).
      orderType: storefrontType ? STOREFRONT_PAYMENT_CHANNEL : (orderType || "data"),
      originalAmount: finalAmount,
      paystackFee: paystackFee,
    }

    // Origin tag stamped into Paystack metadata/custom_fields. Lets us read, on
    // the Paystack dashboard, exactly which backend path produced any txn — and
    // flag any txn lacking the "datagod_backend" source as not ours.
    const paymentChannel =
      storefrontType ? STOREFRONT_PAYMENT_CHANNEL
        : type === "dealer_upgrade" ? "dealer_upgrade"
        : orderType === "airtime" ? "shop_airtime"
        : orderType === "results_checker" ? "shop_results_checker"
        : orderType === "results_check_service" ? "shop_results_check"
        : orderId ? "shop_data"
        : "wallet_topup"

    // Human label shown on the Paystack receipt + dashboard "Purpose" field.
    const paymentPurpose =
      storefrontType ? STOREFRONT_PAYMENT_PURPOSE
        : type === "dealer_upgrade" ? "Dealer Upgrade"
        : orderType === "airtime" ? "Airtime top-up"
        : orderType === "results_checker" ? "Results Checker voucher"
        : orderType === "results_check_service" ? "Results Check Service"
        : orderId ? "Data bundle"
        : "Wallet Top-up"

    // A payment priced for Hubtel carries no Paystack fee, so a fallback re-prices it before Paystack is called: the
    // row's amount, fee and method change together, in one update. If that can't happen, nothing is charged.
    let rowMethod: Gateway = gateway
    const repriceForPaystack = async (): Promise<{ amount: number }> => {
      const fee = initializeFee({ surface: gatewaySurface, gateway: "paystack", feeBearer, standardFee })
      // An order's own price with the fee inside moves first: if the payment row then fails, nothing is charged and
      // the next start puts the price right again for whichever gateway it resolves to.
      if (movablePrice && feeBearer === "customer") {
        const priced = await priceOrderForGateway(supabase, movablePrice.spec, orderId, movablePrice.price, false)
        if (!priced.ok) throw new FallbackRefusedError()
        movablePrice.price = priced.price
        finalAmount = priced.price.paid
        paymentMetadata.originalAmount = finalAmount
      }
      const amount = finalAmount + fee
      let changed = false
      try {
        const { data, error } = await supabase
          .from("wallet_payments")
          .update({ amount, fee, payment_method: "paystack" })
          .eq("reference", reference)
          .eq("status", "pending")
          .select("id")
        if (error) console.error(`[PAYMENT-INIT] ❌ Could not re-price ${reference} for Paystack:`, error.message)
        changed = !error && (data?.length ?? 0) > 0
      } catch (e) {
        console.error(`[PAYMENT-INIT] ❌ Could not re-price ${reference} for Paystack:`, e instanceof Error ? e.message : "unknown error")
      }
      if (!changed) throw new FallbackRefusedError()
      paystackFee = fee
      rowMethod = "paystack"
      paymentMetadata.paystackFee = fee
      return { amount }
    }
    // Only a payment priced for Hubtel needs it; one priced for Paystack already charges the right amount.
    const fallbackHook = gateway === "hubtel" ? { onFallback: repriceForPaystack } : {}
    const fallbackRefused = () =>
      NextResponse.json({ error: "Could not start the payment. Please try again.", code: "try_again" }, { status: 503 })

    // ── Direct MoMo charge path ──────────────────────────────────────────────
    // We charge a SERVER-SPECIFIED MoMo number directly via Paystack /charge — no
    // hosted redirect page where a random victim number could be typed. The
    // existing charge.success webhook resolves `reference` → wallet_payments →
    // order exactly as the redirect flow does, so fulfillment is unchanged.
    //
    // OTP and direct charge are independent: when the surface's OTP gate is ON the
    // number must be SMS-verified (the prompt can ONLY reach a verified number);
    // when OTP is OFF the number is charged as typed, guarded by rate caps below.
    if (momoDirect) {
      // Only honor momoDirect when the surface's direct-charge gate is ON (admins
      // bypass for support/testing). Blocks a client invoking direct charge when
      // the admin hasn't enabled it for this surface.
      if (!surfaceDirectOn && !isAdmin) {
        logSecurityEvent("momodirect_gate_off", {
          channel: paymentChannel, ip: clientIp, email, orderId: orderId || null,
        })
        // code lets a page with a stale toggle fall back to the hosted checkout.
        return NextResponse.json({ error: "Direct charge is not available right now.", code: DIRECT_CHARGE_OFF }, { status: 400 })
      }
      // Shop orders must reference an order; the order-free flows (wallet top-up,
      // dealer upgrade) legitimately have no orderId — their amount is already
      // server-verified above (bounded top-up amount / plan price) and the
      // charge.success webhook credits the wallet / applies the upgrade via
      // reference → wallet_payments → user, exactly like the hosted redirect.
      if (!orderId && !isTopup && !isUpgrade) {
        return NextResponse.json({ error: "Direct MoMo charge requires an order." }, { status: 400 })
      }
      const payPhone = gateway === "hubtel" && canonicalPhone ? canonicalPhone : momoPhoneText(paymentPhone)
      const provider = detectMomoProvider(payPhone)
      if (!provider) {
        return NextResponse.json({ error: "Could not detect mobile money network from the payment number." }, { status: 400 })
      }
      if (surfaceOtpOn && !isAdmin) {
        // OTP gate ON: the payment number MUST have a REAL SMS OTP (used=true) — a
        // past order does not count (strict, no grandfather). Server-enforced; the
        // client can't fake it. Fails CLOSED, so a direct charge can never reach a
        // number whose owner didn't just verify it.
        const payVerified = await isPhoneOtpVerified(payPhone)
        if (!payVerified) {
          logSecurityEvent("momodirect_unverified_payment_number", {
            channel: paymentChannel, ip: clientIp, email, paymentPhone: payPhone, orderId: orderId || null,
          })
          return NextResponse.json(
            { error: "Please verify your payment number to continue.", code: "OTP_REQUIRED" },
            { status: 403 }
          )
        }
      } else if (!isAdmin && gateway !== "hubtel") {
        // (Hubtel direct took this cap before its row was written, above.)
        // OTP gate OFF (direct charge only): no SMS verification, so the typed
        // number is the sole guardrail target. Apply a tight per-phone cap on top
        // of the existing per-IP (3/min, 30/hr) and per-email (5/hr) limits to
        // bound prompt-spam to any single number.
        const phoneCap = await applyRateLimit(request, "momodirect_phone", 3, 60 * 60 * 1000, `mp:${payPhone.replace(/\D/g, "")}`)
        if (!phoneCap.allowed) {
          logSecurityEvent("momodirect_phone_cap", {
            channel: paymentChannel, ip: clientIp, email, paymentPhone: payPhone, orderId: orderId || null,
          })
          return NextResponse.json(
            { error: "Too many payment attempts for this number. Please try again later." },
            { status: 429, headers: { "X-RateLimit-Reset": new Date(phoneCap.resetAt).toISOString() } }
          )
        }
      }

      const chargeParams = {
        email,
        amount: totalAmount,
        phone: payPhone,
        provider,
        reference,
        metadata: paymentMetadata,
        channel: paymentChannel,
        purpose: paymentPurpose,
        recipient,
        ip: clientIp,
      }
      // verifiedPayer only when Hubtel was resolved (the number was checked above), so the wrapper can't go to Hubtel
      // with an amount that includes Paystack's fee. On a Paystack surface the wrapper calls chargeMobileMoney as is.
      let charge: { status: string; gateway: Gateway }
      try {
        charge = gatewaySurface
          ? await startMomoCharge(gatewaySurface, { ...chargeParams, verifiedPayer: gateway === "hubtel", reusedReference: !!replay, ...fallbackHook })
          : { ...(await chargeMobileMoney(chargeParams)), gateway: "paystack" }
      } catch (e) {
        if (e instanceof FallbackRefusedError) return fallbackRefused()
        throw e
      }
      await syncPaymentMethod(reference, rowMethod, charge.gateway)

      // [REFUND] Record the payer MoMo number for storefront shop orders so refund payout gateways know
      // where to pay. Non-fatal and never throws (see recordPayerPhone).
      if ((shopId || botOrder) && orderId && !isTopup && !isUpgrade) {
        await recordPayerPhone(supabase, {
          reference,
          rawPhone: payPhone,
          baseRow: {
            user_id: userId,
            reference,
            amount: finalAmount,
            fee: paystackFee,
            email,
            status: "pending",
            payment_type: orderType === "airtime" ? "shop_airtime" : (orderType === "results_checker" ? "results_checker" : "shop_order"),
            shop_id: shopId || null,
            order_id: orderId,
            created_at: new Date().toISOString(),
          },
        })
      }

      const corsHeaders = getCorsHeaders(request.headers.get("origin"))
      const resp = NextResponse.json({
        success: true,
        momoDirect: true,
        reference,
        status: charge.status, // usually "pay_offline" / "send_otp" / "pending"; Hubtel is always "pay_offline"
        paymentId,
      })
      Object.entries(corsHeaders).forEach(([k, v]) => resp.headers.set(k, v))
      resp.headers.set("Cache-Control", "no-cache, no-store, must-revalidate")
      return resp
    }

    // Card channel can be disabled platform-wide during a card-testing attack
    // by setting PAYMENT_CARD_DISABLED=true. Ghana is mobile-money-first, so
    // dropping card barely affects legit revenue while killing card-testing.
    let hostedChannels = process.env.PAYMENT_CARD_DISABLED === "true"
      ? ["mobile_money", "bank_transfer"]
      : ["card", "mobile_money", "bank_transfer"]
    // Hosted mobile_money strip keys off the DIRECT-CHARGE gate (not the OTP gate).
    // When direct charge is the legit path, the on-page momoDirect flow (handled
    // above) is how MoMo is meant to be paid — so a HOSTED init reaching here is a
    // bypass (e.g. a bot typing victim numbers on Paystack's page). Strip
    // mobile_money so no prompt can fire; card/bank remain for genuine edge cases.
    // When direct charge is OFF the hosted redirect IS the intended MoMo path
    // (even if OTP is on — order creation already gated the number), so momo stays.
    //
    // Wallet/upgrade (order-free) paths.
    // surfaceDirectOn is per-surface: wallet_topup for top-ups, dashboard_direct for upgrades.
    if (surfaceDirectOn && (isTopup || isUpgrade) && !isAdmin) {
      hostedChannels = hostedChannels.filter((c) => c !== "mobile_money")
      if (hostedChannels.length === 0) hostedChannels = ["bank_transfer"]
      // Someone reached the hosted checkout for an order-free path while direct
      // charge is on (legit users use the on-page direct charge). Worth recording.
      logSecurityEvent("wallet_hosted_momo_blocked", { channel: paymentChannel, ip: clientIp, email, userId: userId || null })
    }

    // Storefront SHOP orders (data/airtime/RC).
    if (storefrontDirectOn && orderId && !isAdmin) {
      hostedChannels = hostedChannels.filter((c) => c !== "mobile_money")
      if (hostedChannels.length === 0) hostedChannels = ["bank_transfer"]
      logSecurityEvent("shop_hosted_momo_blocked", { channel: paymentChannel, ip: clientIp, email, orderId, recipient })
    }

    const hostedParams = {
      email,
      amount: totalAmount,
      reference,
      redirectUrl,
      metadata: paymentMetadata,
      channel: paymentChannel,
      purpose: paymentPurpose,
      recipient,
      ip: clientIp,
      channels: hostedChannels,
    }
    let paymentResult: { authorizationUrl: string; accessCode: string; reference: string; gateway: Gateway }
    if (gatewaySurface && !hostedMomoStripped) {
      try {
        paymentResult = await startHostedPayment(gatewaySurface, { ...hostedParams, reusedReference: !!replay, ...fallbackHook })
      } catch (e) {
        if (e instanceof FallbackRefusedError) return fallbackRefused()
        // No safe link to give: Hubtel may hold the request, or this order already has a paid / in-review attempt.
        if (e instanceof HostedStartError) {
          return NextResponse.json({ error: e.message, code: e.code }, { status: e.code === "already_processing" ? 409 : 503 })
        }
        throw e
      }
    } else {
      paymentResult = { ...(await initializePayment(hostedParams)), gateway: "paystack" }
    }
    await syncPaymentMethod(reference, rowMethod, paymentResult.gateway)

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
        payment_type: type === "dealer_upgrade" ? "dealer_upgrade" : (orderType === "airtime" ? "shop_airtime" : (orderType === "results_checker" ? "results_checker" : (shopId || botOrder ? "shop_order" : "wallet_topup"))),
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
      paymentId,
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
