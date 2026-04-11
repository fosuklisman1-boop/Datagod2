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
  const responsePayload = order
    ? { reference: order.api_reference, network: order.network, volume_gb: order.volume_gb, status: order.status }
    : { error: "Order not found" }
  logApiRequest({
    userId: user.id,
    apiKeyId: user.api_key_id,
    method: "GET",
    endpoint: "/api/v1/orders",
    statusCode,
    request,
    durationMs: Date.now() - start,
    requestPayload: { reference },
    responsePayload,
  }).catch(() => {})

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

  // Validate volume_gb is a positive integer
  const volumeGb = Number(volume_gb)
  if (!Number.isInteger(volumeGb) || volumeGb <= 0 || volumeGb > 1000) {
    return NextResponse.json({ success: false, error: "volume_gb must be a positive integer" }, { status: 400 })
  }

  // Validate recipient is a plausible phone number (digits, +, spaces only, 7-15 chars)
  const cleanRecipient = String(recipient).replace(/\s/g, "")
  if (!/^\+?[0-9]{7,15}$/.test(cleanRecipient)) {
    return NextResponse.json({ success: false, error: "Invalid recipient phone number" }, { status: 400 })
  }

  // Validate reference length to prevent DB bloat / injection attempts
  if (typeof reference !== "string" || reference.length < 3 || reference.length > 100) {
    return NextResponse.json({ success: false, error: "reference must be a string between 3 and 100 characters" }, { status: 400 })
  }

  // Sanitize network — strip SQL LIKE wildcards to prevent ilike injection
  const sanitizedNetwork = String(network).replace(/[%_]/g, "")

  // 1. Fetch pricing from global packages table based on role
  // Database stores size as just "1", "2", "5" etc (string)
  const { data: pkg } = await supabase
    .from("packages")
    .select("id, price, dealer_price")
    .ilike("network", sanitizedNetwork)
    .eq("size", volumeGb.toString())
    .eq("active", true)
    .single()

  if (!pkg) {
    return NextResponse.json({ success: false, error: `Package ${network} ${volume_gb}GB not found or unavailable in our database.` }, { status: 400 })
  }

  const orderPrice = user.role === "dealer" && pkg.dealer_price > 0 ? Number(pkg.dealer_price) : Number(pkg.price)

  // --- 2 & 3 & 5. Atomic Order Placement ---
  const description = `API Data Purchase: ${sanitizedNetwork.toUpperCase()} ${volumeGb}GB (${cleanRecipient})`

  const { data: result, error: rpcError } = await supabase.rpc('place_api_order', {
    p_user_id: user.id,
    p_api_key_id: user.api_key_id,
    p_package_id: pkg.id,
    p_network: sanitizedNetwork,
    p_volume_gb: volumeGb,
    p_price: orderPrice,
    p_recipient_phone: cleanRecipient,
    p_api_reference: reference,
    p_description: description
  }) as { data: { success: boolean; order_id: string; new_balance: number; error?: string; required?: number } | null; error: any }

  const durationMs = Date.now() - start

  // Sanitized request payload for logging (strip no-log fields, keep what's useful)
  const loggedRequest = { network: sanitizedNetwork, volume_gb: volumeGb, recipient: cleanRecipient, reference }

  if (rpcError || !result || !result.success) {
    const errorMsg = result?.error || rpcError?.message || "Failed to place order"
    const status = result?.error === 'Insufficient balance' ? 402 :
                   result?.error === 'Duplicate reference' ? 409 : 500

    logApiRequest({
      userId: user.id,
      apiKeyId: user.api_key_id,
      method: "POST",
      endpoint: "/api/v1/orders",
      statusCode: status,
      request,
      durationMs,
      requestPayload: loggedRequest,
      responsePayload: { error: errorMsg, required: result?.required },
    }).catch(() => {})

    return NextResponse.json({
      success: false,
      error: errorMsg,
      required: result?.required
    }, { status })
  }

  const { order_id: orderId, new_balance: newBalance } = result!
  const orderCreatedAt = new Date().toISOString()

  logApiRequest({
    userId: user.id,
    apiKeyId: user.api_key_id,
    method: "POST",
    endpoint: "/api/v1/orders",
    statusCode: 201,
    request,
    durationMs,
    requestPayload: loggedRequest,
    responsePayload: { success: true, order_id: orderId, network: sanitizedNetwork, volume_gb: volumeGb, price: orderPrice, status: "pending" },
  }).catch(() => {})

  // --- 4. Trigger Asynchronous Fulfillment ---
  const normalizedNetwork = sanitizedNetwork.trim().toLowerCase()

  // A. MTN Fulfillment
  if (normalizedNetwork === "mtn") {
    (async () => {
      try {
        const mtnAuto = await isMTNAutoEnabled()
        if (mtnAuto) {
          const mtnRequest = {
            recipient_phone: normalizePhoneNumber(cleanRecipient),
            network: "MTN" as const,
            size_gb: volumeGb,
          }
          const mtnResult = await createMTNOrder(mtnRequest)
          if (orderId && mtnResult.order_id) {
            await saveMTNTracking(String(orderId), mtnResult.order_id, mtnRequest, mtnResult, "api", mtnResult.provider || "sykes")
            if (mtnResult.success) {
              await supabase.from("api_orders").update({ status: "processing" }).eq("id", orderId)
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
            phoneNumber: cleanRecipient,
            sizeGb: volumeGb,
            orderId: orderId,
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
      id: orderId,
      reference,
      network: sanitizedNetwork,
      volume_gb: volumeGb,
      price: orderPrice,
      recipient: cleanRecipient,
      status: "pending",
      created_at: orderCreatedAt,
    }
  }, { status: 201 })
}
