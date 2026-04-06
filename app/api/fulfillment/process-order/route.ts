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
import { isPhoneBlacklisted } from "@/lib/blacklist"

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

    // Check if order is in blacklist queue and get true details
    const { data: orderData, error: orderError } = await supabase
      .from("shop_orders")
      .select("queue, network, volume_gb, customer_phone")
      .eq("id", shop_order_id)
      .single()

    if (orderError || !orderData) {
      console.error("[FULFILLMENT] Error fetching order queue:", orderError)
      return NextResponse.json(
        { error: "Order not found", success: false },
        { status: 404 }
      )
    }

    if (orderData.queue === "blacklisted") {
      console.log(`[FULFILLMENT] ⚠️ Order ${shop_order_id} is in blacklist queue - rejecting fulfillment`)
      return NextResponse.json(
        { error: "Order is blacklisted - fulfillment not allowed", success: false },
        { status: 403 }
      )
    }

    // Check if phone is blacklisted as secondary validation
    try {
      const isBlacklisted = await isPhoneBlacklisted(phone_number)
      if (isBlacklisted) {
        console.log(`[FULFILLMENT] ⚠️ Phone ${phone_number} is blacklisted - rejecting fulfillment`)
        return NextResponse.json(
          { error: "Phone number is blacklisted - fulfillment not allowed", success: false },
          { status: 403 }
        )
      }
    } catch (blacklistError) {
      console.warn("[FULFILLMENT] Error checking blacklist, continuing:", blacklistError)
      // Continue with fulfillment if blacklist check fails
    }

    // Check if MTN auto-fulfillment is enabled
    const autoFulfillmentEnabled = await isAutoFulfillmentEnabled()
    // OVERRIDE client-provided payload with database-verified values
    const verifiedNetwork = orderData.network || network
    const verifiedVolumeGb = orderData.volume_gb || volume_gb
    const verifiedPhonePrefix = orderData.customer_phone || phone_number
    
    const normalizedPhone = normalizePhoneNumber(verifiedPhonePrefix)

    // Check if this is an MTN order
    const isMTNNetwork = verifiedNetwork.toUpperCase() === "MTN"

    if (isMTNNetwork && autoFulfillmentEnabled) {
      // AUTO-FULFILL: Send to MTN API immediately
      console.log("[FULFILLMENT] MTN auto-fulfillment ENABLED - Processing via MTN API")
      return await handleMTNAutoFulfillment(shop_order_id, verifiedNetwork, normalizedPhone, Number(verifiedVolumeGb), customer_name)
    } else if (isMTNNetwork && !autoFulfillmentEnabled) {
      // MANUAL: Queue for download
      console.log("[FULFILLMENT] MTN auto-fulfillment DISABLED - Queuing for manual download")
      return await handleMTNManualFulfillment(shop_order_id, verifiedNetwork, normalizedPhone, Number(verifiedVolumeGb))
    } else {
      // Check if it's a Codecraft network
      const fulfillableNetworks = ["AT - ISHARE", "AT-ISHARE", "TELECEL", "AT - BIGTIME", "AT-BIGTIME"]
      const normalizedNetwork = verifiedNetwork.toUpperCase().trim()
      const isCodecraft = fulfillableNetworks.includes(normalizedNetwork)

      if (isCodecraft) {
        // Fetch global auto-fulfillment setting for Codecraft
        const { data: globalSettings } = await supabase
          .from("admin_settings")
          .select("value")
          .eq("key", "auto_fulfillment_enabled")
          .single()
          
        const isCodeCraftAuto = globalSettings?.value?.enabled ?? true
        
        if (isCodeCraftAuto) {
          console.log("[FULFILLMENT] CodeCraft auto-fulfillment ENABLED - Processing via atishareService")
          
          // ATOMIC LOCK: Claim the order before hitting the API
          const { data: lockData } = await supabase
            .from("shop_orders")
            .update({
              order_status: "processing",
              fulfillment_method: "auto_codecraft",
              updated_at: new Date().toISOString()
            })
            .eq("id", shop_order_id)
            .in("order_status", ["pending", "pending_download"])
            .select("id")

          if (!lockData || lockData.length === 0) {
            console.warn(`[FULFILLMENT] CodeCraft order ${shop_order_id} already claimed or processing. Skipping.`)
            return NextResponse.json({
              success: true,
              message: "Order is already being processed",
            })
          }

          // Import dynamically to avoid top-level issues
          const { atishareService } = await import("@/lib/at-ishare-service")
          
          const sizeGbStr = verifiedVolumeGb.toString().replace(/[^0-9]/g, "")
          const sizeGb = parseInt(sizeGbStr) || 0
          const networkLower = verifiedNetwork.toLowerCase()
          const isBigTime = networkLower.includes("bigtime")
          const apiNetwork = networkLower.includes("telecel") ? "TELECEL" : "AT"
          
          // Trigger Codecraft fulfillment asynchronously
          atishareService.fulfillOrder({
            phoneNumber: verifiedPhonePrefix,
            sizeGb,
            orderId: shop_order_id,
            network: apiNetwork,
            orderType: "shop",
            isBigTime,
          }).catch(err => {
            console.error("[FULFILLMENT] Codecraft async error:", err)
          })

          return NextResponse.json({
            success: true,
            message: "CodeCraft auto-fulfillment triggered successfully",
            fulfillment_method: "auto_codecraft",
          })
        }
      }

      // If not auto-fulfillable or auto is disabled, queue for manual
      console.log(`[FULFILLMENT] Network ${verifiedNetwork} queued for manual fulfillment`)
      const { error: updateError } = await supabase
        .from("shop_orders")
        .update({
          order_status: "pending_download",
          fulfillment_method: "manual",
          updated_at: new Date().toISOString(),
        })
        .eq("id", shop_order_id)

      if (updateError) {
        console.error("[FULFILLMENT] Failed to update shop_orders for manual queue:", updateError)
        return NextResponse.json(
          { error: "Failed to queue order for manual fulfillment" },
          { status: 500 }
        )
      }

      return NextResponse.json({
        success: true,
        message: `${verifiedNetwork} order queued for manual fulfillment`,
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

    // ATOMIC LOCK: Claim the order before hitting the API
    // This prevents the background Pusher from picking it up simultaneously
    const { data: lockData, error: lockError } = await supabase
      .from("shop_orders")
      .update({
        order_status: "processing",
        fulfillment_method: "auto_mtn",
        updated_at: new Date().toISOString()
      })
      .eq("id", shopOrderId)
      .in("order_status", ["pending", "pending_download"]) // Must still be in an available status
      .select("id")

    if (lockError || !lockData || lockData.length === 0) {
      console.warn(`[FULFILLMENT] Order ${shopOrderId} already claimed or processing. Skipping.`)
      return NextResponse.json({
        success: true,
        message: "Order is already being processed",
      })
    }

    // Call MTN API
    const mtnResponse = await createMTNOrder(orderRequest)

    if (!mtnResponse.success || !mtnResponse.order_id) {
      console.error("[FULFILLMENT] MTN API failed:", mtnResponse.message)

      // Update shop_orders with pending_download status instead of failed
      // This ensures the order remains in the automated retry loop
      await supabase
        .from("shop_orders")
        .update({
          order_status: "pending_download",
          fulfillment_method: "auto_mtn",
          updated_at: new Date().toISOString(),
        })
        .eq("id", shopOrderId)

      // [NEW] Create initial tracking record even on API failure
      // This ensures the sequential retry logic can proceed on the next attempt
      try {
        await saveMTNTracking(
          shopOrderId,
          "FAILED_INIT_" + Date.now(),
          orderRequest,
          mtnResponse,
          "shop",
          mtnResponse.provider || "datakazina"
        )
      } catch (trackError) {
        console.error("[FULFILLMENT] Failed to save initial failure tracking:", trackError)
      }

      // Notify admins of failure (not customer)
      try {
        const { notifyAdmins } = await import("@/lib/sms-service")
        await notifyAdmins(
          SMSTemplates.fulfillmentFailed(
            shopOrderId.substring(0, 8),
            phoneNumber,
            network,
            volumeGb.toString(),
            mtnResponse.message || "Order could not be processed"
          ),
          "fulfillment_failure",
          shopOrderId,
          true
        )
      } catch (smsError) {
        console.error("[FULFILLMENT] Failed to notify admins of failure:", smsError)
      }

      // Send error Email
      try {
        const { data: so } = await supabase.from('shop_orders').select('customer_email').eq('id', shopOrderId).single();
        if (so?.customer_email) {
          import("@/lib/email-service").then(({ sendEmail, EmailTemplates, notifyAdmins }) => {
            const payload = EmailTemplates.fulfillmentFailed(
              shopOrderId.substring(0, 8),
              phoneNumber,
              network,
              volumeGb.toString(),
              mtnResponse.message || "Order could not be processed"
            );

            // Send to customer
            sendEmail({
              to: [{ email: so.customer_email, name: customerName || "Customer" }],
              subject: payload.subject,
              htmlContent: payload.html,
              referenceId: shopOrderId,
              type: 'fulfillment_failed'
            }).catch(err => console.error("[FULFILLMENT] Failed to send error Email:", err));

            // Notify admins
            notifyAdmins(payload.subject, payload.html)
              .catch(err => console.error("[FULFILLMENT] Failed to notify admins:", err));
          });
        }
      } catch (emailError) {
        console.error("[FULFILLMENT] Error preparing error Email:", emailError);
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
    const trackingId = await saveMTNTracking(shopOrderId, mtnResponse.order_id, orderRequest, mtnResponse, "shop", mtnResponse.provider || "sykes")

    if (!trackingId) {
      console.error("[FULFILLMENT] Failed to save tracking record")
    }

    // Update shop_orders - status is already set to "processing" by the lock above
    // We just update the external_order_id now
    const { error: updateError } = await supabase
      .from("shop_orders")
      .update({
        external_order_id: mtnResponse.order_id?.toString(),
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
        external_order_id: mtnResponse.order_id?.toString(),
        external_response: mtnResponse,
        notes: "Order sent to MTN API - awaiting status sync",
      })
    } catch (logError) {
      console.error("[FULFILLMENT] Failed to create fulfillment log:", logError)
    }

    // Send success SMS with order tracking info
    try {
      // Fetch shop info to determine if this is a storefront order
      const { data: shopOrder } = await supabase
        .from("shop_orders")
        .select("shop_id, customer_phone")
        .eq("id", shopOrderId)
        .single()

      let smsMessage: string

      if (shopOrder?.shop_id) {
        // Storefront order — fetch shop name and owner phone
        const { data: shopInfo } = await supabase
          .from("user_shops")
          .select("shop_name, user_id")
          .eq("id", shopOrder.shop_id)
          .single()

        let ownerPhone = "support"
        if (shopInfo?.user_id) {
          const { data: ownerData } = await supabase
            .from("users")
            .select("phone_number")
            .eq("id", shopInfo.user_id)
            .single()
          if (ownerData?.phone_number) ownerPhone = ownerData.phone_number
        }

        smsMessage = SMSTemplates.shopOrderConfirmed(
          shopInfo?.shop_name || "DATAGOD",
          network,
          volumeGb.toString(),
          phoneNumber,
          ownerPhone
        )
      } else {
        // Wallet/dashboard order
        smsMessage = SMSTemplates.orderPaymentConfirmed(
          network,
          volumeGb.toString(),
          phoneNumber
        )
      }

      await sendSMS({
        phone: phoneNumber,
        message: smsMessage,
        type: "order_confirmed",
      })
    } catch (smsError) {
      console.error("[FULFILLMENT] Failed to send success SMS:", smsError)
    }

    // Send success Email
    try {
      const { data: so } = await supabase.from('shop_orders').select('customer_email').eq('id', shopOrderId).single();
      if (so?.customer_email) {
        import("@/lib/email-service").then(({ sendEmail, EmailTemplates }) => {
          const payload = EmailTemplates.orderPaymentConfirmed(
            mtnResponse.order_id?.toString() || shopOrderId.substring(0, 8),
            network,
            volumeGb.toString(),
            "Paid" // No price available in this context easily, just say Paid
          );
          sendEmail({
            to: [{ email: so.customer_email, name: customerName || "Customer" }],
            subject: payload.subject,
            htmlContent: payload.html,
            referenceId: shopOrderId,
            type: 'order_confirmed'
          }).catch(err => console.error("[FULFILLMENT] Failed to send success Email:", err));
        });
      }
    } catch (emailError) {
      console.error("[FULFILLMENT] Error preparing success Email:", emailError);
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
