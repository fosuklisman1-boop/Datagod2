import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { shopHandleOrFilter } from "@/lib/shop-handle"
import { applyRateLimit } from "@/lib/rate-limiter"
import { verifyTurnstileToken, getRequestIp, isTurnstileEnabled } from "@/lib/turnstile"
import { isStorefrontOtpRequired, isPhoneOtpVerified } from "@/lib/storefront-otp"
import { initializePayment } from "@/lib/paystack"
import { resolveTrustedBaseUrl } from "@/lib/custom-domain-lookup"
import { parseGhanaCardNumber } from "@/lib/ghana-card"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

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
    const { shopSlug, fullName, ghCardNumber, location, region, phoneNumber, customerEmail, turnstileToken, website: honeypot } = body

    if (!shopSlug || typeof shopSlug !== "string" || !shopSlug.trim()) {
      return NextResponse.json({ error: "shopSlug is required" }, { status: 400 })
    }

    const { data: shopRow, error: shopErr } = await supabase
      .from("user_shops")
      .select("id, afa_price")
      .or(shopHandleOrFilter(shopSlug.trim()))
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

    const { data: order, error: orderError } = await supabase
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

    if (orderError || !order) {
      console.error("[SHOP-AFA] Order creation error:", orderError)
      return NextResponse.json({ error: "Failed to initialize order" }, { status: 500 })
    }

    try {
      const baseUrl = await resolveTrustedBaseUrl(request.headers.get("host"))
      const redirectUrl = `${baseUrl}/shop/${shopSlug}/afa/confirmation?orderId=${order.id}`
      const payment = await initializePayment({
        email: customerEmail,
        amount: shopPrice,
        reference: order.id,
        redirectUrl,
        metadata: { shopId, shopSlug, orderType: "shop_afa" },
      })
      return NextResponse.json({ success: true, orderId: order.id, authorizationUrl: payment.authorizationUrl })
    } catch (payErr) {
      console.error("[SHOP-AFA] Paystack init failed:", payErr)
      return NextResponse.json({ error: "Failed to start payment. Please try again." }, { status: 500 })
    }
  } catch (error) {
    console.error("[SHOP-AFA] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
