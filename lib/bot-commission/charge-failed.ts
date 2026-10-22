// Paystack charge.failed for a commission payment (wallet_payments.order_type cs_bill / cs_bundle). A bot order
// (channel 'bots') is failed right away with the guarded bot patch, so a declined MoMo prompt stops counting against
// the engine's pending caps (otherwise the buyer may hit "Too many attempts" on redial until the stale sweep runs).
// failOrderGuarded's bot-commission guards (payment_status 'unpaid', channel 'bots', status 'pending') mean a
// storefront order, a paid order or a closed order is never touched: storefront behaviour is unchanged.
import type { SupabaseClient } from "@supabase/supabase-js"
import { failOrderGuarded } from "@/lib/ussd-hubtel/order-tables"
import { safeDbError } from "@/lib/ussd-hubtel/log-safe"
import { isStorefrontOrderType, STOREFRONT_ORDER_TABLE } from "@/lib/storefront-commission/payment"

const TAG = "WEBHOOK-BOT-CHARGE-FAILED"

/** Fails the bot order behind a declined commission payment (guarded). Returns true when a guarded fail was sent. Never throws. */
export async function failBotOrderForDeclinedCharge(db: SupabaseClient, reference: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("wallet_payments")
      .select("order_id, order_type")
      .eq("reference", reference)
      // A payment that already completed never fails the order behind it (runs before the webhook marks this row
      // failed). In-flight rows can be 'pending' or Paystack's own 'ongoing' / 'abandoned', so only 'completed' is excluded.
      .neq("status", "completed")
      .maybeSingle()
    if (error) throw error
    const p = data as { order_id?: string | null; order_type?: string | null } | null
    if (!p?.order_id || !isStorefrontOrderType(p.order_type)) return false
    await failOrderGuarded(db, STOREFRONT_ORDER_TABLE[p.order_type], p.order_id, true, TAG)
    return true
  } catch (e) {
    console.error(`[${TAG}] could not fail the bot order:`, safeDbError(e))
    return false
  }
}
