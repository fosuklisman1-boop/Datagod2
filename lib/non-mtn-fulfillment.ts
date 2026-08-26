import { atishareService } from "@/lib/at-ishare-service"
import { saveMTNTracking } from "@/lib/mtn-fulfillment"
import { getProviderNameForNetwork, getProviderByName, isProviderCapableForNetwork, NETWORK_TO_REQUEST_NETWORK } from "@/lib/mtn-providers/factory"
import type { MTNOrderRequest, MTNProviderName } from "@/lib/mtn-providers/types"

export interface NonMTNOrderParams {
  phoneNumber: string
  sizeGb: number
  orderId: string
  /** Raw network label as stored on the order, e.g. "AT - iShare", "Telecel", "AT - BigTime". */
  network: string
  orderType: "wallet" | "shop" | "api" | "ussd" | "ussd_shop"
  /**
   * Optional explicit provider choice (e.g. from an admin's manual-fulfillment
   * dropdown). Used only if it's capability-checked for the resolved network;
   * otherwise falls back to the admin-configured default exactly as before.
   */
  providerOverride?: MTNProviderName
}

export interface NonMTNOrderResult {
  success: boolean
  message: string
  reference?: string
  provider: string
}

/** Canonicalize a raw non-MTN network label to the key format the factory's lookup tables use. */
export function normalizeNetworkKey(network: string): string {
  const upper = network.trim().toUpperCase()
  if (upper.includes("BIGTIME") || upper.includes("BIG TIME")) return "AT - BIGTIME"
  if (upper.includes("ISHARE") || upper.includes("I SHARE")) return "AT - ISHARE"
  if (upper.includes("TELECEL")) return "TELECEL"
  return "AIRTELTIGO"
}

// atishareService (CodeCraft) uses "wallet" for dashboard/bulk orders; saveMTNTracking
// (shared with the MTN path) calls the same concept "bulk". Everything else matches.
function toTrackingOrderType(orderType: NonMTNOrderParams["orderType"]): "shop" | "bulk" | "api" | "ussd" | "ussd_shop" {
  return orderType === "wallet" ? "bulk" : orderType
}

/**
 * Resolve the admin-selected provider for a non-MTN network (Telecel / AT-iShare /
 * AT-BigTime) and place the order with it. CodeCraft keeps going through
 * atishareService (its own polling/logging/notification pipeline, unchanged). Any
 * other provider goes through the generic MTNProvider.createOrder() path and gets a
 * mtn_fulfillment_tracking row saved so the existing per-provider sync crons (which
 * filter by provider, not network) can resolve it.
 */
export async function createNonMTNOrder(params: NonMTNOrderParams): Promise<NonMTNOrderResult> {
  const { phoneNumber, sizeGb, orderId, network, orderType, providerOverride } = params
  const normalizedKey = normalizeNetworkKey(network)

  let providerName: MTNProviderName
  if (providerOverride && isProviderCapableForNetwork(normalizedKey, providerOverride)) {
    providerName = providerOverride
  } else {
    if (providerOverride) {
      console.warn(`[NonMTN] Override "${providerOverride}" is not capable for ${normalizedKey} — falling back to admin-configured provider`)
    }
    providerName = await getProviderNameForNetwork(normalizedKey)
  }

  if (providerName === "codecraft") {
    const isBigTime = normalizedKey === "AT - BIGTIME"
    const apiNetwork = normalizedKey === "TELECEL" ? "TELECEL" : "AT"
    const result = await atishareService.fulfillOrder({
      phoneNumber, sizeGb, orderId, network: apiNetwork, orderType, isBigTime,
    })
    return { success: result.success, message: result.message || "", reference: result.reference, provider: "codecraft" }
  }

  const reqNetwork = NETWORK_TO_REQUEST_NETWORK[normalizedKey] ?? "AirtelTigo"
  const mtnRequest: MTNOrderRequest = {
    recipient_phone: phoneNumber,
    network: reqNetwork,
    size_gb: sizeGb,
    client_ref: orderId,
  }
  const provider = getProviderByName(providerName)
  const result = await provider.createOrder(mtnRequest)

  if (result.success && result.order_id) {
    await saveMTNTracking(orderId, result.order_id, mtnRequest, result, toTrackingOrderType(orderType), providerName)
  } else if (!result.success) {
    await saveMTNTracking(orderId, `FAILED_INIT_${Date.now()}`, mtnRequest, result, toTrackingOrderType(orderType), providerName)
  }

  return {
    success: result.success,
    message: result.message,
    reference: result.order_id?.toString(),
    provider: providerName,
  }
}
