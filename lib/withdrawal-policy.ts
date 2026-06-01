import type { SupabaseClient } from "@supabase/supabase-js"

// Cooling-off durations. Tuned for the chargeback risk window:
//   - Most credit-card chargebacks land within 7-30 days of the transaction.
//   - A 7-day cooling-off on the first withdrawal catches the bulk of those.
//   - A 24h gap between subsequent withdrawals limits exfiltration velocity.
const FIRST_WITHDRAWAL_DAYS = 7
const SUBSEQUENT_WITHDRAWAL_HOURS = 24

export interface CoolingOffCheck {
  allowed: boolean
  reason?: string
  earliest_allowed_at?: string  // ISO timestamp
}

/**
 * Server-side withdrawal cooling-off check. Returns { allowed: true } when the
 * shop is past its cooling-off window, otherwise returns { allowed: false } with
 * a customer-facing reason and the timestamp they can retry.
 *
 * Rules:
 *   - Shop's FIRST completed withdrawal must wait FIRST_WITHDRAWAL_DAYS after
 *     the shop's first completed payment (chargeback-risk window).
 *   - Subsequent withdrawals must wait SUBSEQUENT_WITHDRAWAL_HOURS since the
 *     last completed one (extraction-velocity limit).
 *
 * Safe to call with the authenticated user's Supabase client OR with the
 * service-role client. The queries are shop-scoped, not user-scoped.
 */
export async function checkWithdrawalCoolingOff(
  supabase: SupabaseClient,
  shopId: string
): Promise<CoolingOffCheck> {
  // Has this shop ever completed a withdrawal?
  const { data: priorCompleted } = await supabase
    .from("withdrawal_requests")
    .select("updated_at, created_at")
    .eq("shop_id", shopId)
    .eq("status", "completed")
    .order("updated_at", { ascending: false })
    .limit(1)

  if (priorCompleted && priorCompleted.length > 0) {
    // SUBSEQUENT rule — gap since last completed withdrawal
    const lastAt = new Date(priorCompleted[0].updated_at || priorCompleted[0].created_at)
    const elapsedHours = (Date.now() - lastAt.getTime()) / (1000 * 60 * 60)
    if (elapsedHours < SUBSEQUENT_WITHDRAWAL_HOURS) {
      const earliestAt = new Date(lastAt.getTime() + SUBSEQUENT_WITHDRAWAL_HOURS * 60 * 60 * 1000)
      const hoursLeft = Math.ceil(SUBSEQUENT_WITHDRAWAL_HOURS - elapsedHours)
      return {
        allowed: false,
        reason: `You can request your next withdrawal in ${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}.`,
        earliest_allowed_at: earliestAt.toISOString(),
      }
    }
    return { allowed: true }
  }

  // FIRST-WITHDRAWAL rule — must wait FIRST_WITHDRAWAL_DAYS after first completed payment.
  // Look across all order types this shop can receive payments through.
  const [shopRes, airtimeRes, rcRes] = await Promise.all([
    supabase
      .from("shop_orders")
      .select("created_at")
      .eq("shop_id", shopId)
      .eq("payment_status", "completed")
      .order("created_at", { ascending: true })
      .limit(1),
    supabase
      .from("airtime_orders")
      .select("created_at")
      .eq("shop_id", shopId)
      .eq("payment_status", "completed")
      .order("created_at", { ascending: true })
      .limit(1),
    supabase
      .from("results_checker_orders")
      .select("created_at")
      .eq("shop_id", shopId)
      .eq("payment_status", "completed")
      .order("created_at", { ascending: true })
      .limit(1),
  ])

  const earliestTimestamps = [
    shopRes.data?.[0]?.created_at,
    airtimeRes.data?.[0]?.created_at,
    rcRes.data?.[0]?.created_at,
  ]
    .filter((s): s is string => !!s)
    .map((s) => new Date(s).getTime())

  if (earliestTimestamps.length === 0) {
    // No completed payments yet — the balance check will refuse the request
    // anyway. Returning allowed:true keeps the error message accurate.
    return { allowed: true }
  }

  const earliestPaymentAt = new Date(Math.min(...earliestTimestamps))
  const elapsedDays = (Date.now() - earliestPaymentAt.getTime()) / (1000 * 60 * 60 * 24)
  if (elapsedDays < FIRST_WITHDRAWAL_DAYS) {
    const earliestAt = new Date(earliestPaymentAt.getTime() + FIRST_WITHDRAWAL_DAYS * 24 * 60 * 60 * 1000)
    const daysLeft = Math.ceil(FIRST_WITHDRAWAL_DAYS - elapsedDays)
    return {
      allowed: false,
      reason: `New shops have a ${FIRST_WITHDRAWAL_DAYS}-day cooling-off period before the first withdrawal. You can withdraw in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`,
      earliest_allowed_at: earliestAt.toISOString(),
    }
  }

  return { allowed: true }
}
