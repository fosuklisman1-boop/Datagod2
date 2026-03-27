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

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const rateLimit = await applyRateLimit(request, "v1_orders_get", rateLimitCount, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: "Rate limit exceeded." }, { status: 429 })
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

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const postLimit = Math.max(5, Math.floor(rateLimitCount / 3)) // Allow 1/3 of total limit specifically for orders
  const rateLimit = await applyRateLimit(request, "v1_orders_post", postLimit, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: `Rate limit exceeded. Your current limit is ${postLimit} orders/minute.` }, { status: 429 })
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

  // 2. Atomically deduct wallet balance via RPC
  const { data: deductResult, error: deductError } = await supabase.rpc('deduct_wallet', {
    p_user_id: user.id,
    p_amount: orderPrice,
  })

  if (deductError) {
    console.error("[API v1] Wallet deduction RPC error:", deductError)
    return NextResponse.json({ success: false, error: "Failed to process payment. Wallet deduction failed." }, { status: 500 })
  }

  if (!deductResult || deductResult.length === 0) {
    return NextResponse.json({
      success: false,
      error: `Insufficient balance to place this order.`,
      required: orderPrice,
    }, { status: 402 })
  }

  const { new_balance: newBalance, old_balance: balanceBefore } = deductResult[0]

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
    // 4. Refund logic: wallet was already deducted via RPC, so we need to reverse
    console.error("[API v1] Order creation error, refunding wallet:", orderError)
    
    await supabase.from("wallets").update({ 
      balance: balanceBefore,
      updated_at: new Date().toISOString()
    }).eq("user_id", user.id)
    
    // Check if it's a unique constraint error
    if (orderError?.code === '23505') {
       return NextResponse.json({ success: false, error: "Duplicate reference: an order with this reference already exists." }, { status: 409 })
    }
    
    return NextResponse.json({ success: false, error: "Failed to create order" }, { status: 500 })
  }

  // 5. Create transaction record for audit trail and user history
  const { error: transactionError } = await supabase
    .from("transactions")
    .insert([
      {
        user_id: user.id,
        type: "debit",
        source: "api_order",
        amount: orderPrice,
        balance_before: balanceBefore,
        balance_after: newBalance,
        description: `API Data Purchase: ${network.toUpperCase()} ${volume_gb}GB (${recipient})`,
        reference_id: order.id, // Reference to internal api_orders table record
        status: "completed",
        created_at: new Date().toISOString(),
      },
    ])

  if (transactionError) {
    console.error("[API v1] Failed to create transaction ledger entry:", transactionError)
    // Non-blocking: we already have the order record and wallet was deducted.
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
