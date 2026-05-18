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

async function markUssdOrderStatus(orderId: string, status: 'completed' | 'failed' | 'processing') {
  await supabase
    .from("ussd_orders")
    .update({ order_status: status, updated_at: new Date().toISOString() })
    .eq("id", orderId)
}

export async function fulfillUssdOrder(
  orderId: string,
  network: string,
  recipientPhone: string,
  packageSize: string
): Promise<{ success: boolean; message: string }> {
  console.log("[USSD-FULFILL] Starting fulfillment:", { orderId, network, recipientPhone, packageSize })

  // Blacklist check
  try {
    if (await isPhoneBlacklisted(recipientPhone)) {
      console.warn("[USSD-FULFILL] Phone blacklisted:", recipientPhone)
      await markUssdOrderStatus(orderId, 'failed')
      return { success: false, message: "Recipient phone is blacklisted" }
    }
  } catch {
    // Non-fatal — continue if blacklist check fails
  }

  const normalizedPhone = normalizePhoneNumber(recipientPhone)
  const sizeGb = extractGb(packageSize)
  const networkUpper = network.toUpperCase().trim()
  const isMTN = networkUpper === "MTN"

  if (isMTN) {
    const autoEnabled = await isAutoFulfillmentEnabled()
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
        await markUssdOrderStatus(orderId, 'processing')
        try {
          await saveMTNTracking(orderId, "FAILED_INIT_" + Date.now(), orderRequest, mtnResponse, "ussd", mtnResponse.provider || "datakazina")
        } catch { /* non-fatal */ }
        return { success: false, message: mtnResponse.message }
      }

      try {
        await saveMTNTracking(orderId, mtnResponse.order_id, orderRequest, mtnResponse, "ussd", mtnResponse.provider || "sykes")
      } catch { /* non-fatal */ }

      await markUssdOrderStatus(orderId, 'completed')
      console.log("[USSD-FULFILL] ✓ MTN fulfilled:", mtnResponse.order_id)
      return { success: true, message: "Fulfilled via MTN API" }
    } else {
      // MTN auto-fulfillment disabled — flag for manual processing
      await markUssdOrderStatus(orderId, 'processing')
      console.log("[USSD-FULFILL] MTN auto-fulfillment disabled — marked processing for manual action")
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

    const isAutoEnabled = globalSettings?.value?.enabled ?? true

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
        orderType: "ussd",
        isBigTime,
      }).then(async () => {
        await markUssdOrderStatus(orderId, 'completed')
        console.log("[USSD-FULFILL] ✓ Codecraft fulfilled:", orderId)
      }).catch(async (err: any) => {
        console.error("[USSD-FULFILL] Codecraft error:", err)
        await markUssdOrderStatus(orderId, 'failed')
      })

      // Return immediately — Codecraft fulfillment is async
      return { success: true, message: "Codecraft fulfillment triggered" }
    }
  }

  // Unknown or non-auto network — mark processing so admin can handle
  await markUssdOrderStatus(orderId, 'processing')
  console.log("[USSD-FULFILL] Network not auto-fulfillable, marked processing:", network)
  return { success: true, message: `${network} queued for manual fulfillment` }
}
