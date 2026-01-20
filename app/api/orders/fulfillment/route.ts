import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { atishareService } from "@/lib/at-ishare-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(request: NextRequest) {
  try {
    const { action, orderId } = await request.json()

    // Validate required fields
    if (!action || !orderId) {
      return NextResponse.json(
        { error: "Missing required fields: action, orderId" },
        { status: 400 }
      )
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

    // Handle different fulfillment actions
    switch (action) {
      case "trigger":
        return await handleTriggerFulfillment(orderId, supabaseAdmin)

      case "retry":
        return await handleRetryFulfillment(orderId, supabaseAdmin)

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        )
    }
  } catch (error) {
    console.error("[FULFILLMENT] API error:", error)
    return NextResponse.json(
      { error: "Internal server error", details: String(error) },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const orderId = searchParams.get("orderId")

    if (!orderId) {
      return NextResponse.json(
        { error: "Missing required parameter: orderId" },
        { status: 400 }
      )
    }

    // Get fulfillment status
    const fulfillmentStatus = await atishareService.getFulfillmentStatus(orderId)

    if (!fulfillmentStatus) {
      return NextResponse.json(
        { error: "No fulfillment log found for this order" },
        { status: 404 }
      )
    }

    return NextResponse.json({
      success: true,
      fulfillment: fulfillmentStatus,
    })
  } catch (error) {
    console.error("[FULFILLMENT] GET error:", error)
    return NextResponse.json(
      { error: "Internal server error", details: String(error) },
      { status: 500 }
    )
  }
}

/**
 * Handle fulfillment trigger for an order
 */
async function handleTriggerFulfillment(
  orderId: string,
  supabaseAdmin: any
) {
  try {
    console.log(`[FULFILLMENT] Triggering fulfillment for order ${orderId}`)

    // Get order details
    const { data: order, error: orderError } = await supabaseAdmin
      .from("orders")
      .select("*")
      .eq("id", orderId)
      .single()

    if (orderError || !order) {
      return NextResponse.json(
        { error: "Order not found", details: orderError?.message },
        { status: 404 }
      )
    }

    // Check if order is a supported network (MTN, TELECEL, AT, AT - iShare)
    const supportedNetworks = ["MTN", "TELECEL", "AT", "AT-iShare", "AT - iShare", "AT - ishare", "at - ishare"]
    if (!supportedNetworks.some(n => n.toLowerCase() === (order.network || "").toLowerCase())) {
      return NextResponse.json(
        { error: "This order is not for a supported network", network: order.network, supported: ["MTN", "TELECEL", "AT", "AT - iShare"] },
        { status: 400 }
      )
    }

    // Check if already fulfilled
    if (order.fulfillment_status === "success") {
      return NextResponse.json(
        { error: "Order has already been fulfilled", status: "success" },
        { status: 400 }
      )
    }

    // Check if currently processing
    if (order.fulfillment_status === "processing") {
      return NextResponse.json(
        { error: "Order is already being processed", status: "processing" },
        { status: 400 }
      )
    }

    // Extract size in GB
    const sizeGb = parseInt(order.size.toString().replace(/[^0-9]/g, "")) || 0

    // Normalize network name for API
    const networkMap: Record<string, string> = {
      "MTN": "MTN",
      "TELECEL": "TELECEL",
      "AT": "AT",
      "AT-iShare": "AT",
      "AT - iShare": "AT",
      "AT - ishare": "AT",
      "at - ishare": "AT",
    }
    // Normalize to uppercase before lookup
    const normalizedNetwork = order.network?.trim().toUpperCase() || "AT"
    const apiNetwork = networkMap[normalizedNetwork] || order.network || "AT"

    // Trigger fulfillment
    const result = await atishareService.fulfillOrder({
      phoneNumber: order.phone_number,
      sizeGb,
      orderId,
      network: apiNetwork,
    })

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: "Order fulfilled successfully",
        fulfillment: {
          orderId,
          status: "success",
          reference: result.reference,
        },
      })
    } else {
      // Create initial fulfillment log for failed attempt
      await createInitialFulfillmentLog(orderId, order, supabaseAdmin, result)

      return NextResponse.json(
        {
          success: false,
          message: result.message,
          errorCode: result.errorCode,
          willRetry: true,
        },
        { status: 400 }
      )
    }
  } catch (error) {
    console.error(`[FULFILLMENT] Trigger error for order ${orderId}:`, error)
    return NextResponse.json(
      { error: "Failed to trigger fulfillment", details: String(error) },
      { status: 500 }
    )
  }
}

/**
 * Handle retry of a failed fulfillment
 */
async function handleRetryFulfillment(
  orderId: string,
  supabaseAdmin: any
) {
  try {
    console.log(`[FULFILLMENT] Retrying fulfillment for order ${orderId}`)

    // Check if order exists in orders table (wallet orders)
    let order: any = null
    let orderType: "wallet" | "shop" = "wallet"
    let customerEmail: string | undefined = undefined
    
    const { data: walletOrder, error: walletOrderError } = await supabaseAdmin
      .from("orders")
      .select("network, phone_number, size, user_id")
      .eq("id", orderId)
      .single()

    if (walletOrder) {
      order = walletOrder
      orderType = "wallet"
      
      // Fetch user email for wallet orders (needed for BigTime)
      if (walletOrder.user_id) {
        const { data: userData } = await supabaseAdmin
          .from("users")
          .select("email")
          .eq("id", walletOrder.user_id)
          .single()
        customerEmail = userData?.email
      }
    } else {
      // Check shop_orders table
      const { data: shopOrder, error: shopOrderError } = await supabaseAdmin
        .from("shop_orders")
        .select("network, customer_phone, volume_gb, customer_email")
        .eq("id", orderId)
        .single()

      if (shopOrder) {
        order = {
          network: shopOrder.network,
          phone_number: shopOrder.customer_phone,
          size: shopOrder.volume_gb,
        }
        orderType = "shop"
        customerEmail = shopOrder.customer_email
      }
    }

    if (!order) {
      console.error(`[FULFILLMENT] Order ${orderId} not found in orders or shop_orders table`)
      return NextResponse.json(
        { error: "Order not found in any table" },
        { status: 404 }
      )
    }

    console.log(`[FULFILLMENT] Found ${orderType} order:`, order)

    // Check if network is supported for auto-fulfillment
    const networkLower = (order.network || "").toLowerCase()
    const supportedNetworks = ["at", "mtn", "telecel", "bigtime", "ishare"]
    const isSupported = supportedNetworks.some(n => networkLower.includes(n))
    
    if (!isSupported) {
      return NextResponse.json(
        { error: "This network is not supported for auto-fulfillment", providedNetwork: order.network },
        { status: 400 }
      )
    }

    // Determine if BigTime
    const isBigTime = networkLower.includes("bigtime") || networkLower.includes("big time")

    // Attempt retry using fulfillOrder directly
    console.log(`[FULFILLMENT] Raw size value:`, order.size, `(type: ${typeof order.size})`)
    
    // Parse size - handle different formats
    let sizeGb = 0
    if (typeof order.size === "number") {
      sizeGb = order.size
    } else if (order.size) {
      const digits = order.size.toString().replace(/[^0-9]/g, "")
      sizeGb = parseInt(digits) || 0
    }
    
    if (sizeGb === 0) {
      console.error(`[FULFILLMENT] ❌ Could not determine size for order ${orderId}, size value: ${order.size}`)
      return NextResponse.json(
        { error: "Invalid order size", details: `Size value is: ${order.size}` },
        { status: 400 }
      )
    }
    
    console.log(`[FULFILLMENT] Retrying with: phone=${order.phone_number}, size=${sizeGb}GB, network=${order.network}, isBigTime=${isBigTime}`)

    const result = await atishareService.fulfillOrder({
      phoneNumber: order.phone_number,
      sizeGb,
      orderId,
      network: networkLower.includes("mtn") ? "MTN" : 
               networkLower.includes("telecel") ? "TELECEL" : "AT",
      orderType,
      isBigTime,
    })

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: "Retry successful, order fulfilled",
        fulfillment: {
          orderId,
          status: "success",
          reference: result.reference,
        },
      })
    } else {
      return NextResponse.json(
        {
          success: false,
          message: result.message,
          errorCode: result.errorCode,
        },
        { status: 400 }
      )
    }
  } catch (error) {
    console.error(`[FULFILLMENT] Retry error for order ${orderId}:`, error)
    return NextResponse.json(
      { error: "Failed to retry fulfillment", details: String(error) },
      { status: 500 }
    )
  }
}

/**
 * Create initial fulfillment log for a new order
 */
async function createInitialFulfillmentLog(
  orderId: string,
  order: any,
  supabaseAdmin: any,
  result: any
) {
  try {
    await supabaseAdmin.from("fulfillment_logs").insert([
      {
        order_id: orderId,
        network: order.network,
        phone_number: order.phone_number,
        status: "failed",
        attempt_number: 1,
        max_attempts: 3,
        api_response: result,
        error_message: result.message,
        retry_after: calculateRetryTime(1),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ])
  } catch (error) {
    console.error("[FULFILLMENT] Error creating initial fulfillment log:", error)
  }
}

/**
 * Calculate retry time with exponential backoff
 */
function calculateRetryTime(attemptNumber: number): string {
  let delayMinutes = 5

  if (attemptNumber === 2) {
    delayMinutes = 15
  } else if (attemptNumber === 3) {
    delayMinutes = 60
  }

  const nextTime = new Date()
  nextTime.setMinutes(nextTime.getMinutes() + delayMinutes)
  return nextTime.toISOString()
}
