import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import {
  isAutoFulfillmentEnabled,
  createMTNOrder,
  saveMTNTracking,
  validatePhoneNetworkMatch,
  normalizePhoneNumber,
  MTNOrderRequest,
} from "@/lib/mtn-fulfillment"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export interface FulfillmentRequest {
  shop_order_id: string
  network: string
  phone_number: string
  volume_gb: number
  customer_name?: string
}

export interface FulfillmentResponse {
  success: boolean
  message: string
  order_id?: number | string
  fulfillment_method?: "auto_mtn" | "manual"
  error?: string
}

/**
 * POST /api/fulfillment/process-order
 * Main fulfillment endpoint that routes to MTN auto-fulfill or manual download
 * Called after payment is verified
 */
export async function POST(request: NextRequest) {
  try {
    const body: FulfillmentRequest = await request.json()
    const { shop_order_id, network, phone_number, volume_gb, customer_name } = body

    console.log("[FULFILLMENT] Processing order:", {
      shop_order_id,
      network,
      volume_gb,
    })

    // Validate input
    if (!shop_order_id || !network || !phone_number || !volume_gb) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      )
    }

    // Check if MTN auto-fulfillment is enabled
    const autoFulfillmentEnabled = await isAutoFulfillmentEnabled()
    const normalizedPhone = normalizePhoneNumber(phone_number)

    // Check if this is an MTN order
    const isMTNNetwork = network.toUpperCase() === "MTN"

    if (isMTNNetwork && autoFulfillmentEnabled) {
      // AUTO-FULFILL: Send to MTN API immediately
      console.log("[FULFILLMENT] MTN auto-fulfillment ENABLED - Processing via MTN API")
      return await handleMTNAutoFulfillment(shop_order_id, network, normalizedPhone, volume_gb, customer_name)
    } else if (isMTNNetwork && !autoFulfillmentEnabled) {
      // MANUAL: Queue for download
      console.log("[FULFILLMENT] MTN auto-fulfillment DISABLED - Queuing for manual download")
      return await handleMTNManualFulfillment(shop_order_id, network, normalizedPhone, volume_gb)
    } else {
      // OTHER NETWORKS: Handle as before (AT-iShare, etc.)
      console.log("[FULFILLMENT] Non-MTN network:", network, "- Skipping fulfillment (handled by specific service)")
      return NextResponse.json({
        success: true,
        message: `${network} fulfillment handled by dedicated service`,
        fulfillment_method: "manual",
      })
    }
  } catch (error) {
    console.error("[FULFILLMENT] Error:", error)
    return NextResponse.json(
      { error: "Fulfillment processing failed", details: error instanceof Error ? error.message : "" },
      { status: 500 }
    )
  }
}

/**
 * Auto-fulfill MTN order via MTN API
 */
async function handleMTNAutoFulfillment(
  shopOrderId: string,
  network: string,
  phoneNumber: string,
  volumeGb: number,
  customerName?: string
): Promise<NextResponse<FulfillmentResponse>> {
  try {
    // Create MTN order request
    const orderRequest: MTNOrderRequest = {
      recipient_phone: phoneNumber,
      network: network as "MTN" | "Telecel" | "AirtelTigo",
      size_gb: volumeGb,
    }

    // Call MTN API
    const mtnResponse = await createMTNOrder(orderRequest)

    if (!mtnResponse.success || !mtnResponse.order_id) {
      console.error("[FULFILLMENT] MTN API failed:", mtnResponse.message)

      // Update shop_orders with error status
      await supabase
        .from("shop_orders")
        .update({
          order_status: "failed",
          fulfillment_method: "auto_mtn",
          updated_at: new Date().toISOString(),
        })
        .eq("id", shopOrderId)

      // Send error SMS to customer
      try {
        await sendSMS({
          phone: phoneNumber,
          message: SMSTemplates.fulfillmentFailed(
            shopOrderId.substring(0, 8),
            phoneNumber,
            network,
            volumeGb.toString(),
            mtnResponse.message || "Order could not be processed"
          ),
          type: "fulfillment_failed",
        })
      } catch (smsError) {
        console.error("[FULFILLMENT] Failed to send error SMS:", smsError)
      }

      return NextResponse.json(
        {
          success: false,
          message: mtnResponse.message,
          fulfillment_method: "auto_mtn",
          error: mtnResponse.message,
        },
        { status: 400 }
      )
    }

    // Save tracking record
    const trackingId = await saveMTNTracking(shopOrderId, mtnResponse.order_id, orderRequest, mtnResponse, "shop")

    if (!trackingId) {
      console.error("[FULFILLMENT] Failed to save tracking record")
    }

    // Update shop_orders - set to "pending" so cron job can sync actual status from Sykes
    const { error: updateError } = await supabase
      .from("shop_orders")
      .update({
        order_status: "pending",
        fulfillment_method: "auto_mtn",
        external_order_id: mtnResponse.order_id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", shopOrderId)

    if (updateError) {
      console.error("[FULFILLMENT] Failed to update shop_orders:", updateError)
    }

    // Create fulfillment log
    try {
      await supabase.from("fulfillment_logs").insert({
        order_id: shopOrderId,
        order_type: "shop",
        status: "pending",
        external_api: "MTN",
        external_order_id: mtnResponse.order_id,
        external_response: mtnResponse,
        notes: "Order sent to MTN API - awaiting status sync",
      })
    } catch (logError) {
      console.error("[FULFILLMENT] Failed to create fulfillment log:", logError)
    }

    // Send success SMS with order tracking info
    try {
      await sendSMS({
        phone: phoneNumber,
        message: SMSTemplates.orderPaymentConfirmed(
          mtnResponse.order_id?.toString() || shopOrderId.substring(0, 8),
          network,
          volumeGb.toString(),
          "Paid"
        ),
        type: "order_confirmed",
      })
    } catch (smsError) {
      console.error("[FULFILLMENT] Failed to send success SMS:", smsError)
    }

    console.log("[FULFILLMENT] ✓ MTN order created:", mtnResponse.order_id)

    return NextResponse.json({
      success: true,
      message: "Order auto-fulfilled via MTN API",
      order_id: mtnResponse.order_id,
      fulfillment_method: "auto_mtn",
    })
  } catch (error) {
    console.error("[FULFILLMENT] MTN auto-fulfillment error:", error)
    return NextResponse.json(
      {
        success: false,
        message: "MTN auto-fulfillment failed",
        fulfillment_method: "auto_mtn",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}

/**
 * Queue MTN order for manual fulfillment
 */
async function handleMTNManualFulfillment(
  shopOrderId: string,
  network: string,
  phoneNumber: string,
  volumeGb: number
): Promise<NextResponse<FulfillmentResponse>> {
  try {
    // Update shop_orders to mark as pending_download
    const { error: updateError } = await supabase
      .from("shop_orders")
      .update({
        order_status: "pending_download",
        fulfillment_method: "manual",
        updated_at: new Date().toISOString(),
      })
      .eq("id", shopOrderId)

    if (updateError) {
      console.error("[FULFILLMENT] Failed to update shop_orders:", updateError)
      throw updateError
    }

    // Create fulfillment log
    try {
      await supabase.from("fulfillment_logs").insert({
        order_id: shopOrderId,
        order_type: "shop",
        status: "pending_download",
        external_api: "MTN",
        notes: "Queued for manual fulfillment - Admin action required",
      })
    } catch (logError) {
      console.error("[FULFILLMENT] Failed to create fulfillment log:", logError)
    }

    console.log("[FULFILLMENT] ✓ MTN order queued for manual download:", shopOrderId)

    return NextResponse.json({
      success: true,
      message: "Order queued for manual fulfillment - Admin action required",
      fulfillment_method: "manual",
    })
  } catch (error) {
    console.error("[FULFILLMENT] Manual fulfillment queueing error:", error)
    return NextResponse.json(
      {
        success: false,
        message: "Failed to queue order for manual fulfillment",
        fulfillment_method: "manual",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
