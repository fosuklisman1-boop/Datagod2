import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createMTNOrder, saveMTNTracking, MTNOrderRequest } from "@/lib/mtn-fulfillment"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * POST /api/admin/fulfillment/manual-fulfill
 * Admin manually triggers fulfillment for queued MTN orders
 */
export async function POST(request: NextRequest) {
  try {
    // Verify admin access
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const body = await request.json()
    const { shop_order_id } = body

    if (!shop_order_id) {
      return NextResponse.json(
        { error: "shop_order_id is required" },
        { status: 400 }
      )
    }

    console.log("[MANUAL-FULFILL] Admin triggering fulfillment for:", shop_order_id)

    // Fetch order details
    const { data: orderData, error: fetchError } = await supabase
      .from("shop_orders")
      .select("id, network, volume_gb, customer_phone, customer_name, order_status")
      .eq("id", shop_order_id)
      .single()

    if (fetchError || !orderData) {
      return NextResponse.json(
        { error: "Order not found" },
        { status: 404 }
      )
    }

    // Check if already fulfilled
    if (orderData.order_status === "completed" || orderData.order_status === "failed") {
      return NextResponse.json(
        { error: `Order already ${orderData.order_status}` },
        { status: 400 }
      )
    }

    // Check if MTN order
    if (orderData.network?.toUpperCase() !== "MTN") {
      return NextResponse.json(
        { error: `Network ${orderData.network} is not MTN` },
        { status: 400 }
      )
    }

    // Create MTN order
    // Use parseFloat to preserve decimal values, then round for API
    const volumeGb = parseFloat(orderData.volume_gb?.toString() || "0")
    const mtnRequest: MTNOrderRequest = {
      recipient_phone: orderData.customer_phone,
      network: "MTN",
      size_gb: volumeGb, // createMTNOrder will round to integer
    }

    const mtnResponse = await createMTNOrder(mtnRequest)

    if (!mtnResponse.success || !mtnResponse.order_id) {
      console.error("[MANUAL-FULFILL] MTN API failed:", mtnResponse.message)

      // Update order status
      await supabase
        .from("shop_orders")
        .update({
          order_status: "failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", shop_order_id)

      // Send error SMS
      try {
        await sendSMS({
          phone: orderData.customer_phone,
          message: SMSTemplates.fulfillmentFailed(
            shop_order_id.substring(0, 8),
            orderData.customer_phone,
            orderData.network || "MTN",
            orderData.volume_gb?.toString() || "0",
            mtnResponse.message || "Order could not be processed"
          ),
          type: "fulfillment_failed",
        })
      } catch (smsError) {
        console.error("[MANUAL-FULFILL] Failed to send error SMS:", smsError)
      }

      return NextResponse.json(
        {
          success: false,
          message: mtnResponse.message,
          error: mtnResponse.message,
        },
        { status: 400 }
      )
    }

    // Save tracking
    const trackingId = await saveMTNTracking(shop_order_id, mtnResponse.order_id, mtnRequest, mtnResponse)

    // Update shop_orders
    const { error: updateError } = await supabase
      .from("shop_orders")
      .update({
        order_status: "pending",
        external_order_id: mtnResponse.order_id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", shop_order_id)

    if (updateError) {
      console.error("[MANUAL-FULFILL] Failed to update shop_orders:", updateError)
    }

    // Create fulfillment log
    try {
      await supabase.from("fulfillment_logs").insert({
        order_id: shop_order_id,
        order_type: "shop",
        status: "pending",
        external_api: "MTN",
        external_order_id: mtnResponse.order_id,
        external_response: mtnResponse,
        notes: "Manually fulfilled by admin via MTN API",
      })
    } catch (logError) {
      console.error("[MANUAL-FULFILL] Failed to create fulfillment log:", logError)
    }

    // Send success SMS
    try {
      const sizeGb = parseInt(orderData.volume_gb?.toString() || "0")
      await sendSMS({
        phone: orderData.customer_phone,
        message: SMSTemplates.orderPaymentConfirmed(
          shop_order_id.substring(0, 8),
          "MTN",
          sizeGb.toString(),
          "0"
        ),
        type: "order_fulfilled",
      })
    } catch (smsError) {
      console.error("[MANUAL-FULFILL] Failed to send success SMS:", smsError)
    }

    console.log("[MANUAL-FULFILL] ✓ Order fulfilled:", shop_order_id)

    return NextResponse.json({
      success: true,
      message: "Order fulfilled successfully",
      mtn_order_id: mtnResponse.order_id,
      tracking_id: trackingId,
    })
  } catch (error) {
    console.error("[MANUAL-FULFILL] Error:", error)
    return NextResponse.json(
      { error: "Fulfillment failed", details: error instanceof Error ? error.message : "" },
      { status: 500 }
    )
  }
}

/**
 * GET /api/admin/fulfillment/manual-fulfill
 * List pending MTN orders awaiting manual fulfillment
 */
export async function GET(request: NextRequest) {
  try {
    // Get pending MTN orders
    const { data: orders, error } = await supabase
      .from("shop_orders")
      .select(
        `
        id,
        network,
        volume_gb,
        customer_phone,
        customer_name,
        customer_email,
        order_status,
        fulfillment_method,
        created_at,
        updated_at
      `
      )
      .eq("network", "MTN")
      .eq("order_status", "pending_download")
      .order("created_at", { ascending: false })
      .limit(100)

    if (error) {
      console.error("[MANUAL-FULFILL] Failed to fetch pending orders:", error)
      return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      count: orders?.length || 0,
      orders: orders || [],
    })
  } catch (error) {
    console.error("[MANUAL-FULFILL] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch pending orders" },
      { status: 500 }
    )
  }
}
