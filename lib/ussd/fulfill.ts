import { createClient } from "@supabase/supabase-js"
import {
  isAutoFulfillmentEnabled,
  createMTNOrder,
  saveMTNTracking,
  normalizePhoneNumber,
  MTNOrderRequest,
} from "@/lib/mtn-fulfillment"
import { isPhoneBlacklisted } from "@/lib/blacklist"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function extractGb(packageSize: string): number {
  const digits = packageSize.replace(/[^0-9]/g, '')
  return parseInt(digits) || 0
}

async function markUssdOrderStatus(
  orderId: string,
  status: 'completed' | 'failed' | 'processing' | 'pending',
  orderTable: "ussd_orders" | "ussd_shop_orders" = "ussd_orders"
) {
  await supabase
    .from(orderTable)
    .update({ order_status: status, updated_at: new Date().toISOString() })
    .eq("id", orderId)
}

export async function fulfillUssdOrder(
  orderId: string,
  network: string,
  recipientPhone: string,
  packageSize: string,
  forceManual = false,
  orderTable: "ussd_orders" | "ussd_shop_orders" = "ussd_orders"
): Promise<{ success: boolean; message: string }> {
  console.log("[USSD-FULFILL] Starting fulfillment:", { orderId, network, recipientPhone, packageSize, forceManual })

  // Blacklist check
  try {
    if (await isPhoneBlacklisted(recipientPhone)) {
      console.warn("[USSD-FULFILL] Phone blacklisted:", recipientPhone)
      await markUssdOrderStatus(orderId, 'failed', orderTable)
      return { success: false, message: "Recipient phone is blacklisted" }
    }
  } catch {
    // Non-fatal — continue if blacklist check fails
  }

  const normalizedPhone = normalizePhoneNumber(recipientPhone)
  const sizeGb = extractGb(packageSize)
  const networkUpper = network.toUpperCase().trim()
  const isMTN = networkUpper === "MTN"
  const trackingOrderType = orderTable === "ussd_shop_orders" ? "ussd_shop" : "ussd"

  if (isMTN) {
    const autoEnabled = forceManual || await isAutoFulfillmentEnabled()
    if (autoEnabled) {
      const orderRequest: MTNOrderRequest = {
        recipient_phone: normalizedPhone,
        network: "MTN",
        size_gb: sizeGb,
      }
      const mtnResponse = await createMTNOrder(orderRequest)

      if (!mtnResponse.success || !mtnResponse.order_id) {
        console.error("[USSD-FULFILL] MTN API failed:", mtnResponse.message)
        // Mark processing (not failed) — payment succeeded, admin must manually deliver
        await markUssdOrderStatus(orderId, 'pending', orderTable)
        try {
          await saveMTNTracking(orderId, "FAILED_INIT_" + Date.now(), orderRequest, mtnResponse, trackingOrderType, mtnResponse.provider || "datakazina")
        } catch { /* non-fatal */ }
        return { success: false, message: mtnResponse.message }
      }

      try {
        await saveMTNTracking(orderId, mtnResponse.order_id, orderRequest, mtnResponse, trackingOrderType, mtnResponse.provider || "sykes")
      } catch { /* non-fatal */ }

      await markUssdOrderStatus(orderId, 'processing', orderTable)
      console.log("[USSD-FULFILL] ✓ MTN order placed, awaiting cron confirmation:", mtnResponse.order_id)
      return { success: true, message: "Fulfilled via MTN API" }
    } else {
      // MTN auto-fulfillment disabled — leave it in the MANUAL queue. 'pending'
      // is the status the admin fulfillment list fetches; 'processing' means
      // "placed with a provider, awaiting cron" and would hide it from both the
      // queue and the sync cron (which only follows mtn_fulfillment_tracking rows).
      await markUssdOrderStatus(orderId, 'pending', orderTable)
      console.log("[USSD-FULFILL] MTN auto-fulfillment disabled — marked pending for manual action")
      return { success: true, message: "Queued for manual MTN fulfillment" }
    }
  }

  // Codecraft networks: Telecel, AT-iShare, AT-BigTime
  const fulfillableNetworks = ["AT - ISHARE", "AT-ISHARE", "TELECEL", "AT - BIGTIME", "AT-BIGTIME", "AIRTELTIGO"]
  const isCodecraft = fulfillableNetworks.includes(networkUpper)

  if (isCodecraft) {
    const { data: globalSettings } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "auto_fulfillment_enabled")
      .single()

    const isAutoEnabled = forceManual || (globalSettings?.value?.enabled ?? true)

    if (isAutoEnabled) {
      const networkLower = network.toLowerCase()
      const isBigTime = networkLower.includes("bigtime")
      const apiNetwork = networkLower.includes("telecel") ? "TELECEL" : "AT"

      const { atishareService } = await import("@/lib/at-ishare-service")
      atishareService.fulfillOrder({
        phoneNumber: recipientPhone,
        sizeGb,
        orderId,
        network: apiNetwork,
        orderType: trackingOrderType,
        isBigTime,
      }).then(async (result) => {
        // Only mark processing if the API call was accepted; on failure set back to pending
        // so the order reappears in the retry list
        if (result.success) {
          await markUssdOrderStatus(orderId, 'processing', orderTable)
          console.log("[USSD-FULFILL] ✓ Codecraft order placed, awaiting cron confirmation:", orderId)
        } else {
          console.error("[USSD-FULFILL] Codecraft returned failure:", result.message)
          await markUssdOrderStatus(orderId, 'pending', orderTable)
        }
      }).catch(async (err: any) => {
        console.error("[USSD-FULFILL] Codecraft error:", err)
        await markUssdOrderStatus(orderId, 'pending', orderTable)
      })

      // Return immediately — Codecraft fulfillment is async
      return { success: true, message: "Codecraft fulfillment triggered" }
    }
  }

  // Auto-fulfillment off (Codecraft) or unknown network — leave it in the MANUAL
  // queue. 'pending' is what the admin fulfillment list fetches; 'processing'
  // would strand it (invisible to the queue, untouched by the sync cron).
  await markUssdOrderStatus(orderId, 'pending', orderTable)
  console.log("[USSD-FULFILL] Network not auto-fulfilled, marked pending for manual action:", network)
  return { success: true, message: `${network} queued for manual fulfillment` }
}
