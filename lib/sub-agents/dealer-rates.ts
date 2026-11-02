import type { SupabaseClient } from "@supabase/supabase-js"

export type DealerRateTier = "customer" | "dealer"

/**
 * Dealer base fee rate for a resolved USSD/WhatsApp dialer? Uses the dialer's resolved rateTier; a dialer
 * without one falls back to the role (dealer/sub_agent), which is what every caller did before.
 */
export function dialerGetsDealerRate(d: { role?: string; rateTier?: DealerRateTier }): boolean {
  if (d.rateTier) return d.rateTier === "dealer"
  return d.role === "dealer" || d.role === "sub_agent"
}

/** Postgres undefined_column, or PostgREST's "column not in schema cache". */
function isMissingColumn(error: { code?: string } | null): boolean {
  return error?.code === "42703" || error?.code === "PGRST204"
}

/**
 * The one place that decides whether an account gets dealer rates (airtime fee, cashback share, bills).
 *  - dealer role: dealer.
 *  - sub_agent: dealer, unless their own shop has dealer_rates_enabled = false.
 *    No shop row, or the column not existing yet (migration 0146 not applied), counts as dealer, as it always has.
 *  - everyone else: customer.
 * Throws on any other read error; callers decide how to treat a failure.
 */
export async function getDealerRateTier(db: SupabaseClient, userId: string): Promise<DealerRateTier> {
  const { data, error } = await db.from("users").select("role").eq("id", userId).maybeSingle()
  if (error) throw error
  const role = (data as { role?: string } | null)?.role
  if (role === "dealer") return "dealer"
  if (role !== "sub_agent") return "customer"

  const { data: shop, error: shopError } = await db
    .from("user_shops")
    .select("dealer_rates_enabled")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle()
  if (shopError) {
    if (isMissingColumn(shopError)) return "dealer"
    throw shopError
  }
  return (shop as { dealer_rates_enabled?: boolean } | null)?.dealer_rates_enabled === false ? "customer" : "dealer"
}
