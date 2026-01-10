import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createMTNOrder, saveMTNTracking, MTNOrderRequest } from "@/lib/mtn-fulfillment"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { isPhoneBlacklisted } from "@/lib/blacklist"
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
    const { shop_order_id, order_type = "shop" } = body

    console.log(`[MANUAL-FULFILL] Received body:`, JSON.stringify(body, null, 2))
    console.log(`[MANUAL-FULFILL] Extracted shop_order_id: "${shop_order_id}", order_type: "${order_type}"`)

    if (!shop_order_id || typeof shop_order_id !== "string" || shop_order_id.trim().length === 0) {
      console.error(`[MANUAL-FULFILL] Invalid shop_order_id: ${shop_order_id}`)
      return NextResponse.json(
        { error: "shop_order_id is required and must be a non-empty string" },
        { status: 400 }
      )
    }

    console.log(`[MANUAL-FULFILL] Admin triggering fulfillment for (${order_type}):`, shop_order_id.trim())

    // Determine which table to query based on order type
    const tableName = order_type === "bulk" ? "orders" : "shop_orders"
    const statusField = order_type === "bulk" ? "status" : "order_status"

    console.log(`[MANUAL-FULFILL] Querying table: ${tableName}, searching for order ID: "${shop_order_id.trim()}"`)

    // Fetch order details - select different columns based on table type
    const selectColumns = order_type === "bulk"
      ? "id, network, size as volume_gb, phone_number, customer_phone, customer_name, order_status, status, queue"
      : "id, network, volume_gb, phone_number, customer_phone, customer_name, order_status, status, queue"

    const { data: orderData, error: fetchError } = await supabase
      .from(tableName)
      .select(selectColumns)
      .eq("id", shop_order_id.trim())
      .single()

    console.log(`[MANUAL-FULFILL] Query result - Error: ${fetchError?.message || "none"}, Data found: ${!!orderData}`)
    if (orderData) {
      console.log(`[MANUAL-FULFILL] Order details - Network: ${orderData.network}, Status: ${orderData.order_status || orderData.status}`)
    }

    if (fetchError || !orderData) {
      console.error(`[MANUAL-FULFILL] Failed to fetch order from ${tableName}:`, fetchError)
      return NextResponse.json(
        { error: `Order not found in ${tableName}` },
        { status: 404 }
      )
    }

    // Get the appropriate status field
    const currentStatus = order_type === "bulk" ? orderData.status : orderData.order_status
    const phone = order_type === "bulk" ? orderData.phone_number : orderData.customer_phone

    // Check if already fulfilled
    if (currentStatus === "completed" || currentStatus === "failed") {
      return NextResponse.json(
        { error: `Order already ${currentStatus}` },
        { status: 400 }
      )
    }

    // Check fulfillment logs to see if already attempted
    const { data: existingLogs, error: logsError } = await supabase
      .from("fulfillment_logs")
      .select("id, status, external_order_id")
      .eq("order_id", shop_order_id.trim())
      .eq("order_type", order_type)
      .order("created_at", { ascending: false })
      .limit(1)

    if (existingLogs && existingLogs.length > 0) {
      const lastLog = existingLogs[0]
      if (lastLog.status === "pending" || lastLog.status === "completed") {
        console.log(`[MANUAL-FULFILL] Order ${shop_order_id} already has fulfillment log with status: ${lastLog.status}`)
        return NextResponse.json(
          { error: `Order already has a ${lastLog.status} fulfillment (ID: ${lastLog.external_order_id})` },
          { status: 400 }
        )
      }
    }

    // Check mtn_fulfillment_tracking to see if already tracked
    const trackingQuery = order_type === "bulk" 
      ? supabase.from("mtn_fulfillment_tracking").select("id, mtn_order_id, status").eq("order_id", shop_order_id.trim())
      : supabase.from("mtn_fulfillment_tracking").select("id, mtn_order_id, status").eq("shop_order_id", shop_order_id.trim())
    
    const { data: existingTracking, error: trackingError } = await trackingQuery
      .order("created_at", { ascending: false })
      .limit(1)

    if (existingTracking && existingTracking.length > 0) {
      const lastTracking = existingTracking[0]
      if (lastTracking.status === "pending" || lastTracking.status === "processing" || lastTracking.status === "completed") {
        console.log(`[MANUAL-FULFILL] Order ${shop_order_id} already tracked in MTN with status: ${lastTracking.status}`)
        return NextResponse.json(
          { error: `Order already tracked with MTN (Order ID: ${lastTracking.mtn_order_id}, Status: ${lastTracking.status})` },
          { status: 400 }
        )
      }
    }

    // Check if MTN order
    if (orderData.network?.toUpperCase() !== "MTN") {
      return NextResponse.json(
        { error: `Network ${orderData.network} is not MTN` },
        { status: 400 }
      )
    }

    // Check if order is in blacklist queue
    if (orderData.queue === "blacklisted") {
      console.log(`[MANUAL-FULFILL] ⚠️ Order ${shop_order_id} is in blacklist queue - rejecting fulfillment`)
      return NextResponse.json(
        { error: "Order is blacklisted - fulfillment not allowed" },
        { status: 403 }
      )
    }

    // Secondary check: verify phone number against blacklist
    try {
      const isBlacklisted = await isPhoneBlacklisted(phone)
      if (isBlacklisted) {
        console.log(`[MANUAL-FULFILL] ⚠️ Phone ${phone} is blacklisted - rejecting fulfillment`)
        return NextResponse.json(
          { error: "Phone number is blacklisted - fulfillment not allowed" },
          { status: 403 }
        )
      }
    } catch (blacklistError) {
      console.warn("[MANUAL-FULFILL] Error checking blacklist:", blacklistError)
      // Continue if blacklist check fails
    }

    // Create MTN order
    // Use parseFloat to preserve decimal values, then round for API
    const volumeGb = parseFloat(orderData.volume_gb?.toString() || "0")
    const mtnRequest: MTNOrderRequest = {
      recipient_phone: phone,
      network: "MTN",
      size_gb: volumeGb, // createMTNOrder will round to integer
    }

    const mtnResponse = await createMTNOrder(mtnRequest)

    if (!mtnResponse.success || !mtnResponse.order_id) {
      console.error("[MANUAL-FULFILL] MTN API failed:", mtnResponse.message)

      // Update order status
      const failureUpdateData = order_type === "bulk" 
        ? { status: "failed", updated_at: new Date().toISOString() }
        : { order_status: "failed", updated_at: new Date().toISOString() }

      await supabase
        .from(tableName)
        .update(failureUpdateData)
        .eq("id", shop_order_id)

      // Send error SMS
      try {
        await sendSMS({
          phone: phone,
          message: SMSTemplates.fulfillmentFailed(
            shop_order_id.substring(0, 8),
            phone,
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

    // Save tracking (use "bulk" if bulk order, otherwise "shop")
    const trackingId = await saveMTNTracking(shop_order_id, mtnResponse.order_id, mtnRequest, mtnResponse, order_type as "shop" | "bulk")

    // Update order in appropriate table
    const updateData = order_type === "bulk" 
      ? { status: "processing", external_order_id: mtnResponse.order_id, updated_at: new Date().toISOString() }
      : { order_status: "processing", external_order_id: mtnResponse.order_id, updated_at: new Date().toISOString() }

    const { error: updateError } = await supabase
      .from(tableName)
      .update(updateData)
      .eq("id", shop_order_id)
    if (updateError) {
      console.error(`[MANUAL-FULFILL] Failed to update ${tableName}:`, updateError)
    }

    // Create fulfillment log
    try {
      await supabase.from("fulfillment_logs").insert({
        order_id: shop_order_id,
        order_type: order_type,
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
        phone: phone,
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
