import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { verifyShopSession } from "@/lib/shop-token"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const NETWORK_PREFIXES: Record<string, string> = {
  "024": "MTN", "054": "MTN", "055": "MTN", "059": "MTN", "025": "MTN",
  "050": "Telecel", "020": "Telecel",
  "027": "AT", "057": "AT", "026": "AT", "028": "AT",
}

function detectNetwork(phone: string): string | null {
  const local = phone.startsWith("0") ? phone : "0" + phone.replace(/^\+233/, "")
  const prefix = local.substring(0, 3)
  return NETWORK_PREFIXES[prefix] || null
}

function generateReference(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const seg = (n: number) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("")
  return `AT-${seg(3)}-${seg(3)}`
}

async function getAdminSetting(key: string): Promise<any> {
  const { data } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", key)
    .single()
  return data?.value ?? null
}

export async function POST(request: NextRequest) {
  try {
    // Rate limit: 5 requests/min per IP (unauthenticated endpoint — primary abuse surface)
    const rateLimit = await applyRateLimit(
      request,
      "shop_airtime_initialize",
      RATE_LIMITS.SHOP_AIRTIME_INITIALIZE.maxRequests,
      RATE_LIMITS.SHOP_AIRTIME_INITIALIZE.windowMs
    )
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: RATE_LIMITS.SHOP_AIRTIME_INITIALIZE.message },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": RATE_LIMITS.SHOP_AIRTIME_INITIALIZE.maxRequests.toString(),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": new Date(rateLimit.resetAt).toISOString(),
          },
        }
      )
    }

    const { shopId, beneficiaryPhone, airtimeAmount, amount: bodyAmount, network: passedNetwork, customerName, customerEmail, paySeparately: bodyPaySeparately } = await request.json()

    if (!shopId || !beneficiaryPhone || (!airtimeAmount && !bodyAmount) || !customerEmail) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }

    // Require __shop_sess cookie set by middleware on /shop/* page load.
    const shopCookie = request.cookies.get("__shop_sess")?.value
    if (!shopCookie) {
      console.warn(`[SHOP-AIRTIME] ❌ Blocked: missing __shop_sess cookie for shop ${shopId}`)
      return NextResponse.json({ error: "Invalid session. Please refresh the page and try again." }, { status: 403 })
    }
    const cookieCheck = verifyShopSession(shopCookie)
    if (!cookieCheck.valid) {
      console.warn(`[SHOP-AIRTIME] ❌ Invalid shop session cookie (${cookieCheck.reason}) for shop ${shopId}`)
      return NextResponse.json({ error: "Invalid session. Please refresh the page and try again." }, { status: 403 })
    }

    const amount = parseFloat(airtimeAmount || bodyAmount)
    if (!isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 })
    }

    const cleanPhone = beneficiaryPhone.replace(/\s/g, "")
    // Prefer passed network (manual selection), fallback to detection
    const network = passedNetwork || detectNetwork(cleanPhone)
    
    if (!network) {
      return NextResponse.json({ error: "Unable to detect network from phone number" }, { status: 400 })
    }

    const networkKey = network.toLowerCase().replace(/\s/g, "_")

    // Find Shop and Merchant
    const { data: shop } = await supabase
      .from("user_shops")
      .select("id, user_id, airtime_markup_mtn, airtime_markup_telecel, airtime_markup_at")
      .eq("id", shopId)
      .single()

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // Get Merchant's Fee Rate (Base Cost)
    const { data: merchantProfile } = await supabase
      .from("users")
      .select("role")
      .eq("id", shop.user_id)
      .single()
    
    const isMerchantDealer = merchantProfile?.role === "dealer"
    const merchantFeeKey = isMerchantDealer ? `airtime_fee_${networkKey}_dealer` : `airtime_fee_${networkKey}_customer`
    const merchantFeeSetting = await getAdminSetting(merchantFeeKey)
    const merchantBaseRate = merchantFeeSetting?.rate ?? 5

    // Get Merchant's Custom Markup
    let customMarkupRate = parseFloat(shop[`airtime_markup_${networkKey}` as keyof typeof shop] as string) || 0
    
    // ENFORCE 10% TOTAL CAP: Total Fee (Base + Markup) cannot exceed 10%
    if (merchantBaseRate + customMarkupRate > 10) {
      console.warn(`[SHOP-AIRTIME] Total fee (${merchantBaseRate + customMarkupRate}%) exceeds 10% cap for merchant ${shop.user_id}. Capping at 10%.`)
      customMarkupRate = Math.max(0, 10 - merchantBaseRate)
    }

    const totalFeeRate = merchantBaseRate + customMarkupRate
    const paySeparately = bodyPaySeparately !== undefined ? bodyPaySeparately : true

    // Calculate Final Price and Delivery Amount
    let feeAmount: number
    let totalPrice: number
    let airtimeToDeliver: number
    
    if (paySeparately) {
      feeAmount = parseFloat((amount * totalFeeRate / 100).toFixed(2))
      totalPrice = parseFloat((amount + feeAmount).toFixed(2))
      airtimeToDeliver = amount
    } else {
      feeAmount = parseFloat((amount * totalFeeRate / (100 + totalFeeRate)).toFixed(2))
      totalPrice = amount
      airtimeToDeliver = parseFloat((amount - feeAmount).toFixed(2))
    }

    const merchantCommission = parseFloat((airtimeToDeliver * customMarkupRate / 100).toFixed(2))

    // DB-level flood guards — active even without Upstash/Redis.
    // Scripts rotate emails easily; phone numbers and shop+window are harder to rotate.
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    const [{ count: pendingByEmail }, { count: pendingByPhone }, { count: pendingByShop5m }, { count: pendingByShop1h }] = await Promise.all([
      // Same email: max 5 pending in last hour (covers buying for ~5 family members)
      supabase
        .from("airtime_orders")
        .select("id", { count: "exact", head: true })
        .eq("customer_email", customerEmail)
        .eq("status", "pending_payment")
        .gte("created_at", oneHourAgo),
      // Same beneficiary phone: max 5 pending in last hour (covers payment retries)
      supabase
        .from("airtime_orders")
        .select("id", { count: "exact", head: true })
        .eq("beneficiary_phone", cleanPhone)
        .eq("status", "pending_payment")
        .gte("created_at", oneHourAgo),
      // Same shop: max 15 pending in 5 minutes (burst cap)
      supabase
        .from("airtime_orders")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", shopId)
        .eq("status", "pending_payment")
        .gte("created_at", fiveMinutesAgo),
      // Same shop: max 60 pending in last hour (sustained cap)
      supabase
        .from("airtime_orders")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", shopId)
        .eq("status", "pending_payment")
        .gte("created_at", oneHourAgo),
    ])

    if ((pendingByEmail ?? 0) >= 5 || (pendingByPhone ?? 0) >= 5) {
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

    // Create Airtime Order (Pending Payment)
    const referenceCode = generateReference()
    const { data: order, error: orderError } = await supabase
      .from("airtime_orders")
      .insert([{
        reference_code: referenceCode,
        network,
        beneficiary_phone: cleanPhone,
        airtime_amount: airtimeToDeliver,
        fee_amount: feeAmount,
        total_paid: totalPrice,
        status: "pending_payment",
        payment_status: "pending_payment",
        shop_id: shopId,
        merchant_commission: merchantCommission,
        customer_name: customerName || "Guest",
        customer_email: customerEmail,
        pay_separately: paySeparately
      }])
      .select()
      .single()

    if (orderError) {
      console.error("[SHOP-AIRTIME] Order creation error:", orderError)
      return NextResponse.json({ error: "Failed to initialize order" }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      orderId: order.id,
      totalPrice,
      reference: referenceCode
    })

  } catch (error) {
    console.error("[SHOP-AIRTIME] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
