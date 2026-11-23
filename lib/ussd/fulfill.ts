import { createClient } from "@supabase/supabase-js"
import {
  isAutoFulfillmentEnabled,
  createMTNOrder,
  saveMTNTracking,
  normalizePhoneNumber,
  MTNOrderRequest,
} from "@/lib/mtn-fulfillment"
import { isPhoneBlacklisted } from "@/lib/blacklist"
import type { MTNProviderName } from "@/lib/mtn-providers/types"
import { holdOutcomeUnknown, isOutcomeUnknown } from "@/lib/mtn-providers/outcome-hold"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/** For logs only: "0551234567" -> "***567". Never log the full recipient number. */
function maskForLog(phone: string | null | undefined): string {
  const d = String(phone ?? "").replace(/\D/g, "")
  return d.length > 3 ? `***${d.slice(-3)}` : "***"
}

function extractGb(packageSize: string): number {
  const digits = packageSize.replace(/[^0-9]/g, '')
  return parseInt(digits) || 0
}

async function markUssdOrderStatus(
  orderId: string,
  status: 'completed' | 'failed' | 'processing' | 'pending',
  orderTable: "ussd_orders" | "ussd_shop_orders" = "ussd_orders",
  /** When set, only rows currently in one of these statuses are changed. */
  onlyFrom?: string[]
) {
  const q = supabase
    .from(orderTable)
    .update({ order_status: status, updated_at: new Date().toISOString() })
    .eq("id", orderId)
  await (onlyFrom ? q.in("order_status", onlyFrom) : q)
}

export async function fulfillUssdOrder(
  orderId: string,
  network: string,
  recipientPhone: string,
  packageSize: string,
  forceManual = false,
  orderTable: "ussd_orders" | "ussd_shop_orders" = "ussd_orders",
  provider?: string,
  // Accepted for parity with processManualFulfillment; this path sends no per-failure admin alert today,
  // so there is nothing to suppress. Forward it to any failure alert added here later.
  opts: { suppressFailureAlerts?: boolean } = {}
): Promise<{ success: boolean; message: string; held?: boolean }> {
  console.log("[USSD-FULFILL] Starting fulfillment:", {
    orderId, network, recipientPhone: maskForLog(recipientPhone), packageSize, forceManual, provider,
    suppressFailureAlerts: opts.suppressFailureAlerts === true,
  })

  // Blacklist check
  try {
    if (await isPhoneBlacklisted(recipientPhone)) {
      console.warn("[USSD-FULFILL] Phone blacklisted:", maskForLog(recipientPhone))
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
        client_ref: orderId, // echoed back in DataKazina's webhook reference
        ...(provider ? { provider } : {}),
      }
      const mtnResponse = await createMTNOrder(orderRequest)

      if (!mtnResponse.success || !mtnResponse.order_id) {
        if (mtnResponse.error_type === "SUPPLIER_NOT_APPROVED" || mtnResponse.error_type === "SUPPLIER_CHECK_UNAVAILABLE") {
          // Strict verification refused the admin-pinned supplier: nothing was sent.
          // Pending, no tracking row (no retry count), no alert; the caller shows the message.
          console.warn("[USSD-FULFILL] MTN pinned supplier refused:", mtnResponse.error_type)
          // Guarded: never overwrite a completed/cancelled order.
          await markUssdOrderStatus(orderId, 'pending', orderTable, ["pending", "processing", "failed"])
          return { success: false, message: mtnResponse.message }
        }
        if (mtnResponse.held) {
          const { holdMtnOrder } = await import("@/lib/mtn-hold")
          await holdMtnOrder({
            table: orderTable, orderId, phone: normalizedPhone,
            errorType: mtnResponse.error_type, strictReason: mtnResponse.strictHoldReason,
          })
          const heldMessage = mtnResponse.error_type === "STRICT_HOLD"
            ? "Held: waiting for a supplier to approve this number"
            : "Held: number pending MTN registration"
          return { success: false, message: heldMessage, held: true }
        }
        if (isOutcomeUnknown(mtnResponse)) {
          // Provider may have created the order — keep it `processing`, never re-fulfillable.
          console.error("[USSD-FULFILL] MTN outcome unknown — holding:", mtnResponse.message)
          await markUssdOrderStatus(orderId, 'processing', orderTable)
          await holdOutcomeUnknown({
            orderId, orderType: trackingOrderType, request: orderRequest, response: mtnResponse,
            provider: mtnResponse.provider || "datakazina", productLabel: "MTN",
          })
          return { success: false, message: mtnResponse.message }
        }
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

  // Non-MTN networks: Telecel, AT-iShare, AT-BigTime
  const fulfillableNetworks = ["AT - ISHARE", "AT-ISHARE", "TELECEL", "AT - BIGTIME", "AT-BIGTIME", "AIRTELTIGO"]
  const isNonMTN = fulfillableNetworks.includes(networkUpper)

  if (isNonMTN) {
    const { data: globalSettings } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "auto_fulfillment_enabled")
      .single()

    const isAutoEnabled = forceManual || (globalSettings?.value?.enabled ?? true)

    if (isAutoEnabled) {
      const { createNonMTNOrder } = await import("@/lib/non-mtn-fulfillment")
      createNonMTNOrder({
        phoneNumber: recipientPhone,
        sizeGb,
        orderId,
        network,
        orderType: trackingOrderType,
        // Admin's explicit dropdown choice — createNonMTNOrder's
        // isProviderCapableForNetwork() re-validates it and falls back to the
        // admin-configured provider if it's ever invalid for this network.
        providerOverride: provider as MTNProviderName | undefined,
      }).then(async (result) => {
        if (result.success) {
          await markUssdOrderStatus(orderId, 'processing', orderTable)
          console.log(`[USSD-FULFILL] ✓ ${result.provider} order placed, awaiting cron confirmation:`, orderId)
        } else if (result.outcomeUnknown) {
          // Tracking row + alert already done; keep the order `processing`.
          console.error(`[USSD-FULFILL] ${result.provider} outcome unknown — holding:`, result.message)
          await markUssdOrderStatus(orderId, 'processing', orderTable)
        } else {
          console.error(`[USSD-FULFILL] ${result.provider} returned failure:`, result.message)
          await markUssdOrderStatus(orderId, 'pending', orderTable)
        }
      }).catch(async (err: any) => {
        console.error("[USSD-FULFILL] Non-MTN fulfillment error:", err)
        await markUssdOrderStatus(orderId, 'pending', orderTable)
      })
      return { success: true, message: "Non-MTN fulfillment triggered" }
    }
  }

  // Auto-fulfillment off (Codecraft) or unknown network — leave it in the MANUAL
  // queue. 'pending' is what the admin fulfillment list fetches; 'processing'
  // would strand it (invisible to the queue, untouched by the sync cron).
  await markUssdOrderStatus(orderId, 'pending', orderTable)
  console.log("[USSD-FULFILL] Network not auto-fulfilled, marked pending for manual action:", network)
  return { success: true, message: `${network} queued for manual fulfillment` }
}
