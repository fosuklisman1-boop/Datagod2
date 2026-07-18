import { createClient } from "@supabase/supabase-js"
import { createMTNOrder, saveMTNTracking, checkMTNOrderStatus, MTNOrderRequest, MTNOrderResponse } from "@/lib/mtn-fulfillment"
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
  orderType: "shop" | "bulk" | "api" = "shop",
  provider?: string,
  skipSms = false
): Promise<FulfillmentResult> {
  const logPrefix = `[FULFILLMENT-SERVICE][${orderId}]`
  console.log(`${logPrefix} Starting manual fulfillment for ${orderType}`)

  try {
    const tableName = orderType === "bulk" ? "orders" : orderType === "api" ? "api_orders" : "shop_orders"
    const statusField = orderType === "bulk" || orderType === "api" ? "status" : "order_status"

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
    } else if (orderType === "api") {
      // NOTE: api_orders has no `queue` column (it never joined the blacklist-queue
      // feature). Selecting it errors with "column does not exist", which surfaced as
      // a misleading "Order not found". The orderData.queue check below is simply
      // skipped for API orders; the isPhoneBlacklisted() check still applies.
      const response = await supabase
        .from(tableName)
        .select("id, network, volume_gb, recipient_phone, status, user_id")
        .eq("id", orderId.trim())
        .single()
      orderData = response.data
      fetchError = response.error
      if (orderData) {
        orderData.order_status = orderData.status
        orderData.customer_phone = orderData.recipient_phone
        orderData.customer_name = "API Order"
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
      // Log the underlying error too — a query error (e.g. a bad column) otherwise
      // masquerades as a missing row and makes this very hard to diagnose.
      console.error(`${logPrefix} Order not found in ${tableName}`, fetchError ? `(${fetchError.message})` : "(no matching row)")
      return { success: false, message: "Order not found", orderId }
    }

    const currentStatus = orderType === "bulk" ? orderData.status : orderData.order_status
    const phone = orderType === "bulk" ? orderData.phone_number : orderData.customer_phone

    if (currentStatus === "completed") {
      return { success: false, message: "Order already completed", orderId }
    }

    const isMTN = orderData.network?.toUpperCase() === "MTN"
    const fulfillableNetworks = ["AT - ISHARE", "AT-ISHARE", "TELECEL", "AT - BIGTIME", "AT-BIGTIME", "AIRTELTIGO"]
    const normalizedNetwork = orderData.network?.toUpperCase().trim() || ""
    const isNonMTN = fulfillableNetworks.includes(normalizedNetwork)

    if (!isMTN && !isNonMTN) {
      return { success: false, message: `Network ${orderData.network} is not supported for manual fulfillment`, orderId }
    }

    if (orderData.queue === "blacklisted" || await isPhoneBlacklisted(phone)) {
      return { success: false, message: "Phone is blacklisted", orderId }
    }

    // Check existing tracking/logs strictly for MTN orders to avoid dual execution
    let existingTracking: any = null
    if (isMTN) {
      // Tracking rows are keyed by order type (see saveMTNTracking): bulk -> order_id,
      // api -> api_order_id, shop -> shop_order_id.
      const trackingColumn = orderType === "bulk" ? "order_id" : orderType === "api" ? "api_order_id" : "shop_order_id"

      const { data } = await supabase
        .from("mtn_fulfillment_tracking")
        .select("id, mtn_order_id, status, retry_count, provider")
        .eq(trackingColumn, orderId.trim())
        .order("created_at", { ascending: false })
        .limit(1)
      existingTracking = data

      if (existingTracking && existingTracking.length > 0) {
        const lastTracking = existingTracking[0]
        const isFailedId = lastTracking.mtn_order_id?.toString().startsWith("FAILED")

        if (!isFailedId && ["pending", "processing", "completed"].includes(lastTracking.status)) {
          // Inconsistency: tracking has a real MTN ID but order is still "pending".
          // This happens when auto-fulfillment hit the API successfully but the subsequent
          // order-status DB update failed. Repair the drift instead of hard-blocking.
          if (currentStatus === "pending") {
            const reconcileStatus = lastTracking.status === "completed" ? "completed" : "processing"
            await supabase
              .from(tableName)
              .update({ [statusField]: reconcileStatus, updated_at: new Date().toISOString() })
              .eq("id", orderId)
            console.log(`${logPrefix} Reconciled order status to "${reconcileStatus}" — MTN tracking already exists (tracking status: ${lastTracking.status})`)
            return {
              success: true,
              message: `Order status reconciled to ${reconcileStatus} — already submitted to MTN`,
              orderId,
              trackingId: lastTracking.id,
            }
          }
          return { success: false, message: `Already tracked with MTN (${lastTracking.status})`, orderId }
        }

        // For a real (non-FAILED_INIT) MTN order ID whose tracking status is "failed":
        // verify with MTN before allowing a retry. If MTN still has the original order
        // active, reconcile locally and block — retrying would cause double-fulfillment.
        if (!isFailedId && lastTracking.status === "failed") {
          console.log(`${logPrefix} Tracking status is "failed" with real MTN ID ${lastTracking.mtn_order_id} — verifying with MTN before retry`)
          try {
            const statusCheck = await checkMTNOrderStatus(lastTracking.mtn_order_id, lastTracking.provider)
            if (statusCheck.success && statusCheck.status && ["pending", "processing", "completed"].includes(statusCheck.status)) {
              const reconcileStatus = statusCheck.status === "completed" ? "completed" : "processing"
              await supabase
                .from(tableName)
                .update({ [statusField]: reconcileStatus, updated_at: new Date().toISOString() })
                .eq("id", orderId)
              await supabase
                .from("mtn_fulfillment_tracking")
                .update({ status: reconcileStatus, updated_at: new Date().toISOString() })
                .eq("id", lastTracking.id)
              console.log(`${logPrefix} MTN confirmed order ${lastTracking.mtn_order_id} is "${statusCheck.status}" — reconciled to "${reconcileStatus}", blocking retry to prevent double-fulfillment`)
              return {
                success: true,
                message: `Order reconciled to ${reconcileStatus} — MTN confirmed the original submission was active (preventing double-fulfillment)`,
                orderId,
                trackingId: lastTracking.id,
              }
            }
            // MTN confirmed failure or was unreachable — safe to retry
            console.log(`${logPrefix} MTN confirmed order ${lastTracking.mtn_order_id} is truly failed (${statusCheck.status ?? "unreachable"}) — proceeding with retry`)
          } catch (checkErr) {
            // If status check itself fails, log but proceed conservatively with retry
            console.warn(`${logPrefix} Could not verify MTN status for ${lastTracking.mtn_order_id}, proceeding with retry:`, checkErr)
          }
        }
      }
    }

    // Provider selection — honour an explicit override, otherwise read the admin-selected provider
    let finalProvider = provider
    if (!finalProvider) {
      if (isMTN) {
        const { getMTNProvider } = await import("@/lib/mtn-providers/factory")
        finalProvider = (await getMTNProvider()).name
      } else {
        const { getProviderNameForNetwork } = await import("@/lib/mtn-providers/factory")
        finalProvider = await getProviderNameForNetwork(normalizedNetwork)
      }
    }

    // ATOMIC LOCK - Order
    const { data: orderLock, error: orderLockError } = await supabase
      .from(tableName)
      .update({ [statusField]: "processing", updated_at: new Date().toISOString() })
      .eq("id", orderId)
      .in(statusField, ["pending", "failed", "reversed"])
      .select("id")

    if (orderLockError || !orderLock || orderLock.length === 0) {
      return { success: false, message: "Order already processing or fulfilled", orderId }
    }

    const volumeGb = parseFloat(orderData.volume_gb?.toString() || "0")

    if (isNonMTN) {
      const networkLower = orderData.network?.toLowerCase() || ""
      const isBigTime = networkLower.includes("bigtime")

      if (finalProvider === "codecraft") {
        console.log(`${logPrefix} Processing Codecraft manual fulfillment: ${normalizedNetwork}`)
        const { atishareService } = await import("@/lib/at-ishare-service")
        const apiNetwork = networkLower.includes("telecel") ? "TELECEL" : "AT"

        try {
          const codecraftResponse = await atishareService.fulfillOrder({
            phoneNumber: phone,
            sizeGb: volumeGb,
            orderId: orderId,
            network: apiNetwork,
            orderType: orderType === "bulk" ? "wallet" : orderType === "api" ? "api" : "shop",
            isBigTime
          })

          if (!codecraftResponse.success) {
            console.error(`${logPrefix} Codecraft API failed: ${codecraftResponse.message}`)
            await supabase.from(tableName).update({ [statusField]: "pending", updated_at: new Date().toISOString() }).eq("id", orderId)
            if (!skipSms) import("@/lib/sms-service").then(({ notifyAdmins, SMSTemplates }) => {
              notifyAdmins(
                SMSTemplates.fulfillmentFailed(orderId.substring(0, 8), phone, orderData.network || "Codecraft", volumeGb.toString(), codecraftResponse.message || "Failed"),
                "fulfillment_failure", orderId, true
              ).catch(e => console.error(`${logPrefix} Admin SMS Error:`, e))
            })
            import("@/lib/push-service").then(({ notifyAdminsPush }) => {
              notifyAdminsPush({
                title: '⚠️ Fulfillment Failed',
                body: `${orderData.network || "Codecraft"} ${volumeGb}GB to ${phone} — ${codecraftResponse.message || "Failed"} (Order: ${orderId.substring(0, 8)})`,
                data: { url: '/admin/orders' },
              }).catch(() => { })
            }).catch(() => { })
            return { success: false, message: codecraftResponse.message || "Codecraft API Error", orderId }
          }

          return { success: true, message: "Codecraft API processing started", orderId, trackingId: codecraftResponse.reference }
        } catch (err: any) {
          console.error(`${logPrefix} Codecraft Error:`, err)
          await supabase.from(tableName).update({ [statusField]: "pending", updated_at: new Date().toISOString() }).eq("id", orderId)
          return { success: false, message: err.message || "Codecraft Internal error", orderId }
        }
      } else {
        // Non-CodeCraft provider (Xpress, Datakazina, EazyGhData) for non-MTN network
        console.log(`${logPrefix} Processing ${finalProvider} manual fulfillment: ${normalizedNetwork}`)
        const { getProviderByName, NETWORK_TO_REQUEST_NETWORK } = await import("@/lib/mtn-providers/factory")
        const p = getProviderByName(finalProvider as any)
        const reqNetwork = NETWORK_TO_REQUEST_NETWORK[normalizedNetwork] ?? "AirtelTigo"

        try {
          const result = await p.createOrder({ recipient_phone: phone, network: reqNetwork, size_gb: volumeGb, client_ref: orderId })

          if (!result.success) {
            console.error(`${logPrefix} ${finalProvider} API failed: ${result.message}`)
            await supabase.from(tableName).update({ [statusField]: "pending", updated_at: new Date().toISOString() }).eq("id", orderId)
            if (!skipSms) import("@/lib/sms-service").then(({ notifyAdmins, SMSTemplates }) => {
              notifyAdmins(
                SMSTemplates.fulfillmentFailed(orderId.substring(0, 8), phone, orderData.network || finalProvider!, volumeGb.toString(), result.message || "Failed"),
                "fulfillment_failure", orderId, true
              ).catch(e => console.error(`${logPrefix} Admin SMS Error:`, e))
            })
            import("@/lib/push-service").then(({ notifyAdminsPush }) => {
              notifyAdminsPush({
                title: '⚠️ Fulfillment Failed',
                body: `${orderData.network || finalProvider} ${volumeGb}GB to ${phone} — ${result.message || "Failed"} (Order: ${orderId.substring(0, 8)})`,
                data: { url: '/admin/orders' },
              }).catch(() => { })
            }).catch(() => { })
            return { success: false, message: result.message || `${finalProvider} API Error`, orderId }
          }

          return { success: true, message: `${finalProvider} processing started`, orderId, trackingId: result.order_id?.toString() }
        } catch (err: any) {
          console.error(`${logPrefix} ${finalProvider} Error:`, err)
          await supabase.from(tableName).update({ [statusField]: "pending", updated_at: new Date().toISOString() }).eq("id", orderId)
          return { success: false, message: err.message || `${finalProvider} internal error`, orderId }
        }
      }
    }

    // Call MTN API
    const mtnRequest: MTNOrderRequest = {
      recipient_phone: phone,
      network: "MTN",
      size_gb: volumeGb,
      provider: finalProvider,
      client_ref: orderId, // echoed back in DataKazina's webhook reference
    }

    // A thrown error here (provider timeout, network drop, 500) must NOT leave the
    // order stranded in "processing" — that state has no tracking row, so the sync
    // cron can never see it and the atomic lock can never re-claim it. Convert any
    // throw into a normal failure so the revert-to-pending path below runs.
    let mtnResponse: MTNOrderResponse
    try {
      mtnResponse = await createMTNOrder(mtnRequest)
    } catch (apiErr) {
      console.error(`${logPrefix} MTN API threw an exception:`, apiErr)
      mtnResponse = {
        success: false,
        message: apiErr instanceof Error ? apiErr.message : "MTN API error (exception)",
      }
    }

    if (!mtnResponse.success || !mtnResponse.order_id) {
      if (mtnResponse.held) {
        console.log(`${logPrefix} Registration gate hold — number not yet registered`)
        const { holdMtnOrder } = await import("@/lib/mtn-hold")
        await holdMtnOrder({ table: tableName as any, orderId, phone })
        return { success: false, message: "Held: number pending MTN registration", orderId }
      }
      console.error(`${logPrefix} MTN API failed: ${mtnResponse.message}`)

      await supabase.from(tableName).update({ [statusField]: "pending", updated_at: new Date().toISOString() }).eq("id", orderId)

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
      // Notify admins of failure (not customer)
      if (!skipSms) import("@/lib/sms-service").then(({ notifyAdmins, SMSTemplates }) => {
        notifyAdmins(
          SMSTemplates.fulfillmentFailed(orderId.substring(0, 8), phone, "MTN", volumeGb.toString(), mtnResponse.message || "Failed"),
          "fulfillment_failure",
          orderId,
          true
        ).catch(e => console.error(`${logPrefix} Admin SMS Error:`, e))
      })

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
    if (!skipSms) sendSMS({
      phone,
      message: SMSTemplates.orderPaymentConfirmed("MTN", Math.round(volumeGb).toString(), phone),
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
