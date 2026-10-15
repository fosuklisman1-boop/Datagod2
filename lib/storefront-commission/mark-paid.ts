import type { SupabaseClient } from "@supabase/supabase-js"
import type { StorefrontOrderTable } from "./payment"

/** Channels whose bill / bundle rows the commission confirmation serves (kept in sync with confirm.ts COMMISSION_CHANNELS). */
const PAYABLE_CHANNELS = ["storefront", "bots"] as const

/**
 * The guarded `unpaid -> paid` write for a commission bill / bundle row (channel storefront or bots). Only a row that
 * is still `payment_status = 'unpaid'` changes, so a second caller (or a replay) is a no-op. `extra` adds columns to
 * the same atomic update (the Hubtel USSD needs-review recording sets status / failure_reason with it). `channels`
 * narrows the channel guard. Returns rows changed; throws the PostgREST error.
 */
export async function markCommissionOrderPaid(
  db: SupabaseClient,
  table: StorefrontOrderTable,
  id: string,
  patch: { paid_at: string; payment_reference: string },
  opts: { extra?: Record<string, unknown>; channels?: readonly string[] } = {},
): Promise<number> {
  const { data, error } = await db
    .from(table)
    .update({
      ...(opts.extra ?? {}),
      payment_status: "paid", paid_at: patch.paid_at, payment_reference: patch.payment_reference, updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .in("channel", [...(opts.channels ?? PAYABLE_CHANNELS)])
    .eq("payment_status", "unpaid")
    .select("id")
  if (error) throw error
  return data?.length ?? 0
}
