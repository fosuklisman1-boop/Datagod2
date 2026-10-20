import type { SupabaseClient } from "@supabase/supabase-js"
import { failOrderGuarded } from "@/lib/ussd-hubtel/flow-kit"
import { safeDbError } from "@/lib/ussd-hubtel/log-safe"
import { STOREFRONT_ORDER_TABLE, type StorefrontOrderType } from "@/lib/storefront-commission/payment"

/**
 * A bot MoMo charge that did not go through (charge not started, charge call threw / was refused, OTP rejected):
 * mark this payment's wallet_payments row failed (only while still pending) and fail the order with the bot
 * commission guarded patch (`status 'failed'`, `failure_reason 'payment not completed'`, filtered on payment_status
 * 'unpaid', channel 'bots', status 'pending'; see failOrderGuarded / ORDER_TABLES). A paid order is never touched.
 * Never throws.
 */
export async function failBotCharge(
  db: SupabaseClient, orderType: StorefrontOrderType, orderId: string, reference: string | null, logTag: string,
): Promise<void> {
  if (reference) {
    try {
      const { error } = await db
        .from("wallet_payments")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("reference", reference)
        .eq("status", "pending")
      if (error) console.error(`[${logTag}] could not mark payment failed:`, safeDbError(error))
    } catch (e) {
      console.error(`[${logTag}] could not mark payment failed:`, safeDbError(e))
    }
  }
  await failOrderGuarded(db, STOREFRONT_ORDER_TABLE[orderType], orderId, true, logTag)
}
