import { createClient } from "@supabase/supabase-js"
import { createMTNOrder, saveMTNTracking, MTNOrderRequest, getNextMTNProvider } from "@/lib/mtn-fulfillment"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { isPhoneBlacklisted } from "@/lib/blacklist"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export interface FulfillmentResult {
  success: boolean
  message: string
  orderId: string
  mtnOrderId?: string | number
  trackingId?: string
}

/**
 * Process manual fulfillment for a single order
 * Reused by single and bulk fulfillment APIs
 */
export async function processManualFulfillment(
  orderId: string,
  orderType: "shop" | "bulk" = "shop",
  provider?: string
): Promise<FulfillmentResult> {
  const logPrefix = `[FULFILLMENT-SERVICE][${orderId}]`
  console.log(`${logPrefix} Starting manual fulfillment for ${orderType}`)

  try {
    const tableName = orderType === "bulk" ? "orders" : "shop_orders"
    const statusField = orderType === "bulk" ? "status" : "order_status"

    // Fetch order details
    let orderData: any
    let fetchError: any

    if (orderType === "bulk") {
      const response = await supabase
        .from(tableName)
        .select("id, network, size, phone_number, status, queue, user_id")
        .eq("id", orderId.trim())
        .single()
      orderData = response.data
      fetchError = response.error
      if (orderData) {
        orderData.volume_gb = orderData.size
        orderData.order_status = orderData.status
        orderData.customer_phone = orderData.phone_number
        orderData.customer_name = "Bulk Order"
      }
    } else {
      const response = await supabase
        .from(tableName)
        .select("id, network, volume_gb, customer_phone, customer_name, customer_email, order_status, queue")
        .eq("id", orderId.trim())
        .single()
      orderData = response.data
      fetchError = response.error
    }

    if (fetchError || !orderData) {
      console.error(`${logPrefix} Order not found in ${tableName}`)
      return { success: false, message: "Order not found", orderId }
    }

    const currentStatus = orderType === "bulk" ? orderData.status : orderData.order_status
    const phone = orderType === "bulk" ? orderData.phone_number : orderData.customer_phone

    if (currentStatus === "completed") {
      return { success: false, message: "Order already completed", orderId }
    }

    // Check existing tracking/logs
    const trackingQuery = orderType === "bulk"
      ? supabase.from("mtn_fulfillment_tracking").select("id, mtn_order_id, status, retry_count").eq("order_id", orderId.trim())
      : supabase.from("mtn_fulfillment_tracking").select("id, mtn_order_id, status, retry_count").eq("shop_order_id", orderId.trim())

    const { data: existingTracking } = await trackingQuery.order("created_at", { ascending: false }).limit(1)

    if (existingTracking && existingTracking.length > 0) {
      const lastTracking = existingTracking[0]
      const isFailedId = lastTracking.mtn_order_id?.toString().startsWith("FAILED")
      if (!isFailedId && ["pending", "processing", "completed"].includes(lastTracking.status)) {
        return { success: false, message: `Already tracked with MTN (${lastTracking.status})`, orderId }
      }
    }

    // Network & Blacklist check
    if (orderData.network?.toUpperCase() !== "MTN") {
      return { success: false, message: `Network ${orderData.network} is not MTN`, orderId }
    }

    if (orderData.queue === "blacklisted" || await isPhoneBlacklisted(phone)) {
      return { success: false, message: "Phone is blacklisted", orderId }
    }

    // Provider selection
    let finalProvider = provider
    if (!provider && existingTracking && existingTracking.length > 0) {
      finalProvider = getNextMTNProvider(existingTracking[0].retry_count || 0)
    }

    // ATOMIC LOCK - Order
    const { data: orderLock, error: orderLockError } = await supabase
      .from(tableName)
      .update({ [statusField]: "processing", updated_at: new Date().toISOString() })
      .eq("id", orderId)
      .in(statusField, ["pending", "pending_download", "failed"])
      .select("id")

    if (orderLockError || !orderLock || orderLock.length === 0) {
      return { success: false, message: "Order already processing or fulfilled", orderId }
    }

    // Call MTN API
    const volumeGb = parseFloat(orderData.volume_gb?.toString() || "0")
    const mtnRequest: MTNOrderRequest = {
      recipient_phone: phone,
      network: "MTN",
      size_gb: volumeGb,
      provider: finalProvider,
    }

    const mtnResponse = await createMTNOrder(mtnRequest)

    if (!mtnResponse.success || !mtnResponse.order_id) {
      console.error(`${logPrefix} MTN API failed: ${mtnResponse.message}`)
      
      // Revert to pending_download on failure
      await supabase.from(tableName).update({ [statusField]: "pending_download", updated_at: new Date().toISOString() }).eq("id", orderId)

      // Update or create tracking for retry count
      if (existingTracking && existingTracking.length > 0) {
        await supabase.from("mtn_fulfillment_tracking").update({
          status: "failed",
          retry_count: (existingTracking[0].retry_count || 0) + 1,
          last_retry_at: new Date().toISOString(),
          external_message: mtnResponse.message,
          api_response_payload: mtnResponse,
          updated_at: new Date().toISOString()
        }).eq("id", existingTracking[0].id)
      } else {
        await saveMTNTracking(orderId, "FAILED_INIT_" + Date.now(), mtnRequest, mtnResponse, orderType, finalProvider || "datakazina")
      }

      // Notifications on failure (simplified for background)
      sendSMS({
        phone,
        message: SMSTemplates.fulfillmentFailed(orderId.substring(0, 8), phone, "MTN", volumeGb.toString(), mtnResponse.message || "Failed"),
        type: "fulfillment_failed"
      }).catch(e => console.error(`${logPrefix} SMS Error:`, e))

      return { success: false, message: mtnResponse.message || "MTN API Error", orderId }
    }

    // Success - Save Tracking
    const trackingId = await saveMTNTracking(orderId, mtnResponse.order_id, mtnRequest, mtnResponse, orderType, mtnResponse.provider || "sykes")

    // Update Status with external ID
    const updateData = orderType === "bulk"
      ? { status: "processing", external_order_id: mtnResponse.order_id?.toString(), updated_at: new Date().toISOString() }
      : { order_status: "processing", external_order_id: mtnResponse.order_id?.toString(), updated_at: new Date().toISOString() }

    await supabase.from(tableName).update(updateData).eq("id", orderId)

    // Log
    try {
      await supabase.from("fulfillment_logs").insert({
        order_id: orderId,
        order_type: orderType,
        status: "pending",
        external_api: "MTN",
        external_order_id: mtnResponse.order_id?.toString(),
        external_response: mtnResponse,
        notes: "Manually fulfilled by admin",
      })
    } catch (e: any) {
      console.error(`${logPrefix} Log Error:`, e)
    }

    // Notifications on success
    sendSMS({
      phone,
      message: SMSTemplates.orderPaymentConfirmed(orderId.substring(0, 8), "MTN", Math.round(volumeGb).toString(), "0"),
      type: "order_fulfilled"
    }).catch((e: any) => console.error(`${logPrefix} SMS Error:`, e))

    // Email notification
    try {
      let emailToSend = null;
      let nameToSend = "Customer";

      if (orderType === 'shop') {
        emailToSend = orderData.customer_email;
        nameToSend = orderData.customer_name || "Customer";
      } else if (orderType === 'bulk' && orderData.user_id) {
        const { data: u } = await supabase.from('users').select('email, first_name').eq('id', orderData.user_id).single();
        emailToSend = u?.email;
        nameToSend = u?.first_name || "User";
      }

      if (emailToSend) {
        const { sendEmail, EmailTemplates } = await import("@/lib/email-service");
        const payload = EmailTemplates.orderPaymentConfirmed(orderId.substring(0, 8), "MTN", Math.round(volumeGb).toString(), "Paid/Manual");
        sendEmail({
          to: [{ email: emailToSend, name: nameToSend }],
          subject: payload.subject,
          htmlContent: payload.html, // EmailTemplates returns 'html', sendEmail expects 'htmlContent'
          referenceId: orderId,
          type: 'order_fulfilled_manual'
        }).catch((err: any) => console.error(`${logPrefix} Email error:`, err));
      }
    } catch (e: any) { console.error(`${logPrefix} Email processing error:`, e) }

    return {
      success: true,
      message: "Order fulfilled successfully",
      orderId,
      mtnOrderId: mtnResponse.order_id,
      trackingId: trackingId || undefined
    }

  } catch (error) {
    console.error(`${logPrefix} Error:`, error)
    return { success: false, message: error instanceof Error ? error.message : "Internal service error", orderId }
  }
}
