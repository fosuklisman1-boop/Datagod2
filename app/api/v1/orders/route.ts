import { NextRequest, NextResponse } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"
import { createMTNOrder, saveMTNTracking, normalizePhoneNumber, isAutoFulfillmentEnabled as isMTNAutoEnabled } from "@/lib/mtn-fulfillment"
import { atishareService } from "@/lib/at-ishare-service"

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

  // Check api_orders by reference
  const { data: order } = await supabase
    .from("api_orders")
    .select("api_reference, network, volume_gb, price, recipient_phone, status, provider_reference, error_message, created_at")
    .eq("api_reference", reference)
    .eq("user_id", user.id) // Only return user's own orders
    .single()

  const statusCode = order ? 200 : 404
  logApiRequest({ userId: user.id, apiKeyId: user.api_key_id, method: "GET", endpoint: "/api/v1/orders", statusCode, request, durationMs: Date.now() - start }).catch(() => {})

  if (!order) {
    return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 })
  }

  return NextResponse.json({
    success: true,
    order: {
      reference: order.api_reference,
      network: order.network,
      volume_gb: order.volume_gb,
      price: order.price,
      recipient: order.recipient_phone,
      status: order.status,
      provider_reference: order.provider_reference,
      error_message: order.error_message,
      created_at: order.created_at,
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

  // 1. Fetch pricing from global packages table based on role
  // Database stores size as just "1", "2", "5" etc (string)
  // 1. Fetch pricing from global packages table based on role
  // Database stores size as just "1", "2", "5" etc (string)
  const { data: pkg } = await supabase
    .from("packages")
    .select("id, price, dealer_price")
    .ilike("network", network)
    .eq("size", volume_gb.toString())
    .eq("active", true)
    .single()

  if (!pkg) {
    return NextResponse.json({ success: false, error: `Package ${network} ${volume_gb}GB not found or unavailable in our database.` }, { status: 400 })
  }

  const orderPrice = user.role === "dealer" && pkg.dealer_price > 0 ? Number(pkg.dealer_price) : Number(pkg.price)

  // 2. Safely deduct wallet balance
  const { data: wallet } = await supabase
    .from("wallets")
    .select("id, balance")
    .eq("user_id", user.id)
    .single()

  if (!wallet) {
    return NextResponse.json({ success: false, error: "Wallet not found" }, { status: 402 })
  }

  if (wallet.balance < orderPrice) {
    const shortfall = (orderPrice - wallet.balance).toFixed(2)
    return NextResponse.json({
      success: false,
      error: `Insufficient balance. You need GHS ${shortfall} more to place this order.`,
      balance: wallet.balance,
      required: orderPrice,
    }, { status: 402 })
  }

  // Atomically update balance (ideally use RPC but direct update with service role is okay for now if no concurrent bursts)
  const newBalance = Number((wallet.balance - orderPrice).toFixed(2))
  const { error: walletError } = await supabase
    .from("wallets")
    .update({ balance: newBalance })
    .eq("id", wallet.id)

  if (walletError) {
    console.error("[API v1] Wallet deduction failed:", walletError)
    return NextResponse.json({ success: false, error: "Wallet deduction failed" }, { status: 500 })
  }

  // 3. Create the api_orders record
  const { data: order, error: orderError } = await supabase
    .from("api_orders")
    .insert({
      user_id: user.id,
      api_key_id: user.api_key_id,
      package_id: pkg.id,
      network,
      volume_gb,
      price: orderPrice,
      recipient_phone: recipient,
      api_reference: reference,
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select("id, status, created_at")
    .single()

  const httpStatus = orderError ? 500 : 201
  logApiRequest({ userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/orders", statusCode: httpStatus, request, durationMs: Date.now() - start }).catch(() => {})

  if (orderError || !order) {
    // Rollback wallet deduction conceptually, though manual intervention is needed if this fails.
    console.error("[API v1] Order creation error:", orderError)
    
    // Auto-refund
    await supabase.from("wallets").update({ balance: wallet.balance }).eq("id", wallet.id)
    
    // Check if it's a unique constraint error
    if (orderError?.code === '23505') {
       return NextResponse.json({ success: false, error: "Duplicate reference: an order with this reference already exists." }, { status: 409 })
    }
    
    return NextResponse.json({ success: false, error: "Failed to create order" }, { status: 500 })
  }

  // --- 4. Trigger Asynchronous Fulfillment ---
  const normalizedNetwork = network.trim().toLowerCase()
  
  // A. MTN Fulfillment
  if (normalizedNetwork === "mtn") {
    (async () => {
      try {
        const mtnAuto = await isMTNAutoEnabled()
        if (mtnAuto) {
          const mtnRequest = {
            recipient_phone: normalizePhoneNumber(recipient),
            network: "MTN" as const,
            size_gb: volume_gb,
          }
          const mtnResult = await createMTNOrder(mtnRequest)
          if (mtnResult.order_id) {
            await saveMTNTracking(order.id, mtnResult.order_id, mtnRequest, mtnResult, "api", mtnResult.provider || "sykes")
            if (mtnResult.success) {
              await supabase.from("api_orders").update({ status: "processing" }).eq("id", order.id)
            }
          }
        }
      } catch (err) {
        console.error("[API v1] MTN fulfillment trigger error:", err)
      }
    })()
  } 
  // B. AT / Telecel Fulfillment (CodeCraft)
  else {
    const fulfillableNetworks = ["AT - iShare", "AT-iShare", "AT - ishare", "at - ishare", "Telecel", "telecel", "TELECEL", "AT - BigTime", "AT-BigTime", "AT - bigtime", "at - bigtime"]
    const isAutoFulfillable = fulfillableNetworks.some(n => n.toLowerCase() === normalizedNetwork)
    
    if (isAutoFulfillable) {
      (async () => {
        try {
          const isBigTime = normalizedNetwork.includes("bigtime")
          const apiNetwork = normalizedNetwork.includes("telecel") ? "TELECEL" : "AT"
          
          atishareService.fulfillOrder({
            phoneNumber: recipient,
            sizeGb: volume_gb,
            orderId: order.id,
            network: apiNetwork,
            orderType: "api",
            isBigTime,
          }).catch(err => console.error("[API v1] CodeCraft fulfillment error:", err))
        } catch (err) {
          console.error("[API v1] CodeCraft trigger error:", err)
        }
      })()
    }
  }

  return NextResponse.json({
    success: true,
    message: "Order placed successfully",
    order: {
      id: order.id,
      reference,
      network,
      volume_gb,
      price: orderPrice,
      recipient,
      status: order.status,
      created_at: order.created_at,
    }
  }, { status: 201 })
}
