/**
 * Shared "hold" step for callers that get OUTCOME_UNKNOWN back from a provider.
 *
 * Saves an UNKNOWN_<ts> tracking row (status "abandoned" — the status CHECK has
 * no needs_review and every poller skips abandoned rows) and alerts admins
 * (PII-free). The CALLER must also leave the order `processing` so nothing
 * re-sends it.
 */
import type { MTNOrderRequest, MTNOrderResponse } from "./types"
import { OUTCOME_UNKNOWN, makeUnknownTrackingId } from "./outcome"

export function isOutcomeUnknown(r: { error_type?: string } | null | undefined): boolean {
  return r?.error_type === OUTCOME_UNKNOWN
}

export async function holdOutcomeUnknown(opts: {
  orderId: string
  orderType: "shop" | "bulk" | "api" | "ussd" | "ussd_shop"
  request: MTNOrderRequest
  response: MTNOrderResponse
  provider: string
  /** Label for the alert, e.g. "MTN", "AT". */
  productLabel?: string
  /** When given, also set the order to `processing` (so it is never re-fulfillable). */
  markProcessing?: { table: string; column: string }
}): Promise<{ message: string }> {
  const { orderId, orderType, request, response, provider } = opts
  const message = response.message
  if (opts.markProcessing) {
    try {
      const { supabaseAdmin } = await import("@/lib/supabase")
      await supabaseAdmin
        .from(opts.markProcessing.table)
        .update({ [opts.markProcessing.column]: "processing", updated_at: new Date().toISOString() })
        .eq("id", orderId)
    } catch (e) {
      console.error("[OUTCOME-UNKNOWN] Could not mark order processing:", e)
    }
  }
  try {
    const { saveMTNTracking } = await import("@/lib/mtn-fulfillment")
    await saveMTNTracking(orderId, makeUnknownTrackingId(), request, response, orderType, provider)
  } catch (e) {
    console.error("[OUTCOME-UNKNOWN] Could not save tracking row:", e)
  }
  await alertOutcomeUnknown({ orderId, orderType, provider, productLabel: opts.productLabel ?? request.network })
  return { message }
}

/** PII-free admin alert (no phone numbers): provider, order type, short order id. */
export async function alertOutcomeUnknown(opts: {
  orderId: string
  orderType: string
  provider: string
  productLabel: string
}): Promise<void> {
  try {
    const { notifyAdmins } = await import("@/lib/sms-service")
    await notifyAdmins(
      `Order ${opts.orderId.substring(0, 8)} (${opts.productLabel} ${opts.orderType}): provider ${opts.provider} gave an unreadable reply - the order may have been created. Check the provider dashboard before retrying.`,
      "provider_outcome_unknown",
      opts.orderId,
      true
    )
  } catch (e) {
    console.error("[OUTCOME-UNKNOWN] Admin alert failed:", e)
  }
}
