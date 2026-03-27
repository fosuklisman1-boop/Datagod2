import { NextRequest, NextResponse } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/v1/orders?reference=<ref>
 * Check order status by reference
 */
export async function GET(request: NextRequest) {
  const start = Date.now()

  const rateLimit = await applyRateLimit(request, "v1_orders_get", 60, 60 * 1000)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: "Rate limit exceeded." }, { status: 429 })
  }

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const reference = searchParams.get("reference")

  if (!reference) {
    return NextResponse.json({ success: false, error: "Reference is required" }, { status: 400 })
  }

  // Check shop_orders by reference in payment_attempts
  const { data: paymentAttempt } = await supabase
    .from("payment_attempts")
    .select("reference, status, order_type, created_at")
    .eq("reference", reference)
    .eq("user_id", user.id) // Only return user's own orders
    .single()

  const status = paymentAttempt ? 200 : 404
  logApiRequest({ userId: user.id, apiKeyId: user.api_key_id, method: "GET", endpoint: "/api/v1/orders", statusCode: status, request, durationMs: Date.now() - start }).catch(() => {})

  if (!paymentAttempt) {
    return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 })
  }

  return NextResponse.json({
    success: true,
    order: {
      reference: paymentAttempt.reference,
      status: paymentAttempt.status,
      type: paymentAttempt.order_type,
      created_at: paymentAttempt.created_at,
    }
  })
}

/**
 * POST /api/v1/orders
 * Place a new data order
 */
export async function POST(request: NextRequest) {
  const start = Date.now()

  const rateLimit = await applyRateLimit(request, "v1_orders_post", 20, 60 * 1000)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: "Rate limit exceeded. Max 20 orders/minute." }, { status: 429 })
  }

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  // Only dealers and admins can place orders via API
  if (!["dealer", "admin"].includes(user.role)) {
    return NextResponse.json({ success: false, error: "Insufficient permissions" }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const { network, volume_gb, recipient, reference } = body

  if (!network || !volume_gb || !recipient || !reference) {
    return NextResponse.json({
      success: false,
      error: "Missing required fields: network, volume_gb, recipient, reference"
    }, { status: 400 })
  }

  // Automatically fetch the user's shop ID
  const { data: userShop } = await supabase
    .from("shops")
    .select("id")
    .eq("user_id", user.id)
    .single()

  if (!userShop) {
    return NextResponse.json({
      success: false,
      error: "No shop found for this user account. You must create a shop first."
    }, { status: 400 })
  }
  const shop_id = userShop.id

  // Verify wallet balance covers the order price
  const { data: wallet } = await supabase
    .from("wallets")
    .select("balance")
    .eq("user_id", user.id)
    .single()

  if (!wallet) {
    return NextResponse.json({ success: false, error: "Wallet not found" }, { status: 402 })
  }

  // Look up the package price to ensure balance is sufficient
  const { data: pkg } = await supabase
    .from("shop_data_packages")
    .select("price")
    .eq("shop_id", shop_id)
    .eq("network", network)
    .eq("volume_gb", volume_gb)
    .single()

  if (pkg) {
    const orderPrice = Number(pkg.price)
    if (wallet.balance < orderPrice) {
      const shortfall = (orderPrice - wallet.balance).toFixed(2)
      return NextResponse.json({
        success: false,
        error: `Insufficient balance. You need GHS ${shortfall} more to place this order.`,
        balance: wallet.balance,
        required: orderPrice,
      }, { status: 402 })
    }
  } else if (wallet.balance <= 0) {
    // Fallback: if package not found, still block zero-balance wallets
    return NextResponse.json({ success: false, error: "Insufficient wallet balance" }, { status: 402 })
  }

  // Create a shop order record
  const { data: order, error: orderError } = await supabase
    .from("shop_orders")
    .insert({
      shop_id,
      user_id: user.id,
      network,
      volume_gb,
      customer_phone: recipient,
      status: "pending",
      payment_status: "pending",
      source: "api",
      api_reference: reference,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select("id, status, created_at")
    .single()

  const httpStatus = orderError ? 500 : 201
  logApiRequest({ userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/orders", statusCode: httpStatus, request, durationMs: Date.now() - start }).catch(() => {})

  if (orderError || !order) {
    console.error("[API v1] Order creation error:", orderError)
    return NextResponse.json({ success: false, error: "Failed to create order" }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    message: "Order created successfully",
    order: {
      id: order.id,
      reference,
      network,
      volume_gb,
      recipient,
      status: order.status,
      created_at: order.created_at,
    }
  }, { status: 201 })
}
