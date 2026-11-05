import { NextRequest, NextResponse } from "next/server"
import { resolveCustomerEmail } from "@/lib/guest-email"
import { createClient } from "@supabase/supabase-js"
import { shopHandleOrFilter } from "@/lib/shop-handle"
import { applyRateLimit } from "@/lib/rate-limiter"
import { verifyTurnstileToken, getRequestIp, isTurnstileEnabled } from "@/lib/turnstile"
import { isStorefrontOtpRequired, isPhoneOtpVerified } from "@/lib/storefront-otp"
import { resolveTrustedBaseUrl } from "@/lib/custom-domain-lookup"
import { parseGhanaCardNumber } from "@/lib/ghana-card"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import { FallbackRefusedError, HostedStartError, resolveSurfaceGateway, startHostedPayment } from "@/lib/payment-gateway/start"
import { HUBTEL_REPLAY_LOOKBACK_MS } from "@/lib/payment-gateway/initialize-gateway"
import { decideAttemptReplay, replayUnknown, TRY_AGAIN_BODY, type ReplayDecision } from "@/lib/payment-gateway/web-replay"

// A Hubtel start awaits the relay.
export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const text = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").toLowerCase() : "")
const phoneKey = (v: unknown) => (typeof v === "string" ? normalizeGhanaPhone(v) ?? v.replace(/\s/g, "") : "")

/** Is this retry the registration the pending order was written for? Case, spacing and phone format don't count. */
function sameAfaDetails(
  order: { full_name?: unknown; dialing_phone?: unknown; location?: unknown; region?: unknown },
  req: { fullName: unknown; phone: unknown; location: unknown; region: unknown },
): boolean {
  return text(order.full_name) === text(req.fullName) && phoneKey(order.dialing_phone) === phoneKey(req.phone) &&
    text(order.location) === text(req.location) && text(order.region) === text(req.region)
}

async function getAdminSetting(key: string): Promise<any> {
  const { data } = await supabase.from("admin_settings").select("value").eq("key", key).single()
  return data?.value ?? null
}

// AFA registration is guest-checkout, Paystack-paid — unlike the main
// afa_orders table (NOT NULL user_id, wallet-debit only), this reuses
// ussd_afa_orders (already guest-friendly + shares the same real
// Apex Prime / Sykes provider-dispatch fulfillment engine in
// lib/ussd/fulfill-afa.ts) with shop_id/merchant_commission columns added.
export async function POST(request: NextRequest) {
  try {
    const rateLimit = await applyRateLimit(request, "shop_afa_initialize", 5, 60 * 1000)
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 })
    }

    const body = await request.json()
    const { shopSlug, fullName, ghCardNumber, location, region, phoneNumber, customerEmail: rawCustomerEmail, turnstileToken, website: honeypot } = body
    // Email is optional for the customer; synthesize a guest address from the phone when blank.
    const customerEmail = resolveCustomerEmail(rawCustomerEmail, phoneNumber)

    if (!shopSlug || typeof shopSlug !== "string" || !shopSlug.trim()) {
      return NextResponse.json({ error: "shopSlug is required" }, { status: 400 })
    }

    const { data: shopRow, error: shopErr } = await supabase
      .from("user_shops")
      .select("id, afa_price")
      .or(shopHandleOrFilter(shopSlug.trim()))
      .eq("is_active", true)
      .single()
    if (shopErr || !shopRow) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }
    const shopId = shopRow.id

    if (typeof honeypot === "string" && honeypot.trim() !== "") {
      console.warn(`[SHOP-AFA] ❌ Honeypot tripped for shop ${shopId}`)
      return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    }

    if (!fullName || !ghCardNumber || !location || !region || !phoneNumber || !customerEmail) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }

    // Reject before taking payment — a malformed number here previously only
    // surfaced as a fulfillment failure after the customer had already paid.
    const normalizedGhCard = parseGhanaCardNumber(ghCardNumber)
    if (!normalizedGhCard) {
      return NextResponse.json({ error: `Ghana Card number must be in the format GHA-123456789-0. Got: "${ghCardNumber}"` }, { status: 400 })
    }

    const shopPrice = Number(shopRow.afa_price)
    if (!shopRow.afa_price || !isFinite(shopPrice) || shopPrice <= 0) {
      return NextResponse.json({ error: "AFA registration is not available for this shop right now." }, { status: 400 })
    }

    const turnstileEnabled = await isTurnstileEnabled()
    if (turnstileEnabled) {
      const turnstileResult = await verifyTurnstileToken(turnstileToken, getRequestIp(request.headers))
      if (!turnstileResult.valid) {
        return NextResponse.json({ error: "Verification failed. Please refresh the page and try again." }, { status: 403 })
      }
    }

    if (await isStorefrontOtpRequired()) {
      const verified = await isPhoneOtpVerified(phoneNumber)
      if (!verified) {
        return NextResponse.json(
          { error: "Please verify your phone number to continue.", code: "OTP_REQUIRED" },
          { status: 403 }
        )
      }
    }

    // Real base cost — same source submitAfaOrder charges an authenticated
    // user's wallet from (lib/afa-fulfillment.ts).
    const { data: priceRow } = await supabase
      .from("afa_registration_prices")
      .select("price")
      .eq("is_active", true)
      .eq("name", "default")
      .maybeSingle()
    const basePrice = priceRow?.price != null ? parseFloat(priceRow.price) : NaN
    if (!isFinite(basePrice) || basePrice <= 0) {
      return NextResponse.json({ error: "AFA registration is temporarily unavailable. Please try again later." }, { status: 503 })
    }

    if (shopPrice < basePrice) {
      // The shop's own configured price has drifted below the real cost
      // (e.g. an admin raised the base price after the shop set theirs) --
      // fail rather than sell at a loss for the shop.
      console.error(`[SHOP-AFA] Shop ${shopId} price GHS ${shopPrice} is below current cost GHS ${basePrice}`)
      return NextResponse.json({ error: "AFA registration is not available for this shop right now." }, { status: 400 })
    }

    // Server-enforced cap (unlike the airtime/RC markup caps elsewhere in
    // this app, which are client-only today — flagged separately). Falls
    // back to GHS 10 if no admin override exists yet.
    const capSetting = await getAdminSetting("afa_max_shop_profit")
    const maxProfit = capSetting?.max != null ? Number(capSetting.max) : 10
    const merchantCommission = Math.min(parseFloat((shopPrice - basePrice).toFixed(2)), maxProfit)

    const cleanPhone = String(phoneNumber).replace(/\s/g, "")

    const [emailCap, phoneCap, shop5mCap] = await Promise.all([
      applyRateLimit(request, "shop_afa_cap_email", 3, 60 * 60 * 1000, `e:${customerEmail.toLowerCase()}`),
      applyRateLimit(request, "shop_afa_cap_phone", 3, 60 * 60 * 1000, `p:${cleanPhone}`),
      applyRateLimit(request, "shop_afa_cap_shop_5m", 10, 5 * 60 * 1000, `s:${shopId}`),
    ])
    if (!emailCap.allowed || !phoneCap.allowed || !shop5mCap.allowed) {
      return NextResponse.json(
        { error: "Too many pending orders. Please complete or wait for existing orders to expire." },
        { status: 429 }
      )
    }

    // AFA has no customer fee on either gateway: Paystack has always been charged the plain shop price and the handler
    // checks only that it was covered, so a fallback charges the same amount under the same order id. Every submit
    // creates an order, so a retry is found by this registration's still-pending order with a live Hubtel attempt.
    const { gateway } = await resolveSurfaceGateway("storefront", { verifiedPayer: true, amount: shopPrice })
    const { data: pendingOrders, error: pendingErr } = await supabase
      .from("ussd_afa_orders")
      .select("id, amount, full_name, dialing_phone, location, region")
      .eq("shop_id", shopId)
      .eq("gh_card_number", normalizedGhCard)
      .eq("payment_status", "pending")
      .gte("created_at", new Date(Date.now() - HUBTEL_REPLAY_LOOKBACK_MS).toISOString())
      .order("created_at", { ascending: false })
      .limit(5)
    if (pendingErr) console.error("[SHOP-AFA] pending order lookup failed:", pendingErr.message)
    const replay: ReplayDecision = pendingErr
      ? await replayUnknown("storefront", gateway)
      : await decideAttemptReplay(supabase, "storefront", gateway, { references: (pendingOrders ?? []).map((o) => o.id) })
    if (replay.kind === "refuse") return NextResponse.json(replay.body, { status: replay.status })
    const reused = replay.kind === "replay" ? (pendingOrders ?? []).find((o) => o.id === replay.reference) : undefined
    // A replay pays the order as it was written. Corrected details can't ride on it, and can't get a second live
    // attempt beside it either: the customer finishes or waits out the open one.
    if (reused && !sameAfaDetails(reused, { fullName, phone: cleanPhone, location, region })) {
      return NextResponse.json(
        { error: "A payment for this registration is still in progress. Finish it, or try again a little later.", code: "PAYMENT_IN_PROGRESS" },
        { status: 409 },
      )
    }

    let order: { id: string } | null = reused ?? null
    if (!order) {
      const { data: created, error: orderError } = await supabase
        .from("ussd_afa_orders")
        .insert([{
          dialing_phone: cleanPhone,
          full_name: fullName,
          gh_card_number: normalizedGhCard,
          location,
          region,
          occupation: "Farmer",
          amount: shopPrice,
          payment_status: "pending",
          order_status: "pending",
          shop_id: shopId,
          merchant_commission: merchantCommission,
        }])
        .select("id")
        .single()

      if (orderError || !created) {
        console.error("[SHOP-AFA] Order creation error:", orderError)
        return NextResponse.json({ error: "Failed to initialize order" }, { status: 500 })
      }
      order = created
    }
    const orderId = order!.id

    try {
      const baseUrl = await resolveTrustedBaseUrl(request.headers.get("host"))
      const redirectUrl = `${baseUrl}/shop/${shopSlug}/afa/confirmation?orderId=${orderId}`
      const payment = await startHostedPayment("storefront", {
        email: customerEmail,
        // A replay keeps the price its order was made at: the handler checks the order's amount.
        amount: reused ? Number(reused.amount) : shopPrice,
        reference: orderId,
        redirectUrl,
        metadata: { shopId, shopSlug, orderType: "shop_afa" },
        reusedReference: !!reused,
      })
      return NextResponse.json({ success: true, orderId, authorizationUrl: payment.authorizationUrl })
    } catch (payErr) {
      if (payErr instanceof FallbackRefusedError) return NextResponse.json(TRY_AGAIN_BODY, { status: 503 })
      if (payErr instanceof HostedStartError) {
        return NextResponse.json({ error: payErr.message, code: payErr.code }, { status: payErr.code === "already_processing" ? 409 : 503 })
      }
      console.error("[SHOP-AFA] Paystack init failed:", payErr)
      return NextResponse.json({ error: "Failed to start payment. Please try again." }, { status: 500 })
    }
  } catch (error) {
    console.error("[SHOP-AFA] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
