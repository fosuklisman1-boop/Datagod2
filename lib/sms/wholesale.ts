/**
 * Backed SMS supply for the solvency gate (spec §5.5a). credit_sms_units_if_solvent only
 * issues credits while all balances + this purchase stay ≤ this number, so it must fail
 * CLOSED (0) whenever the real supply is unknown.
 *   Hubtel primary → Disbursement balance (GH₵) ÷ highest per-SMS rate seen in 7 days
 *                    (admin setting sms_hubtel_cost_per_sms until any rate is observed)
 *   otherwise      → Moolre wholesale credit balance (unchanged behaviour)
 */
import { createClient } from "@supabase/supabase-js"
import { getRoutingConfig } from "./routing"
import { hubtelConfigFromEnv } from "./providers/hubtel"
import { fetchDisbursementBalance } from "@/lib/ussd-hubtel/relay"
import { queryMoolreSmsBalance } from "@/lib/sms-service"
import { loadSmsSettings } from "./platform-settings"
import { notifyAdminsThrottled } from "./notify"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export function backedCredits(balanceGhs: number, costPerSms: number): number {
  if (!Number.isFinite(balanceGhs) || !Number.isFinite(costPerSms) || balanceGhs <= 0 || costPerSms <= 0) return 0
  return Math.floor(balanceGhs / costPerSms + 1e-9)
}

/** Highest per-SMS rate Hubtel charged in the window, or null when none observed.
 *  Throws on a query error: a failed lookup must not silently fall back to a possibly lower rate. */
export async function maxObservedHubtelRate(days = 7): Promise<number | null> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const { data, error } = await supabaseAdmin.from("sms_messages").select("cost_ghs")
    .eq("provider", "hubtel").not("cost_ghs", "is", null).gte("processed_at", since)
    .order("cost_ghs", { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error(`observed-rate lookup failed: ${error.message}`)
  const v = Number((data as { cost_ghs?: number | string } | null)?.cost_ghs)
  return Number.isFinite(v) && v > 0 ? v : null
}

export async function getWholesaleCredits(): Promise<number> {
  try {
    const routing = await getRoutingConfig()
    if (routing.primary !== "hubtel" || !hubtelConfigFromEnv()) return await queryMoolreSmsBalance()

    const bal = await fetchDisbursementBalance()
    if (!bal.ok) {
      console.error("[SMS-WHOLESALE] Hubtel balance unavailable — failing closed:", bal.error)
      return 0
    }
    const settings = await loadSmsSettings()
    if (bal.amountGhs < settings.hubtelLowBalanceGhs) {
      notifyAdminsThrottled("sms_hubtel_low_balance", "Hubtel SMS balance low",
        `Hubtel Disbursement balance is GH₵${bal.amountGhs.toFixed(2)} (alert below GH₵${settings.hubtelLowBalanceGhs}). Top it up to keep selling SMS credits.`).catch(() => {})
    }
    const rate = (await maxObservedHubtelRate()) ?? settings.hubtelCostPerSms
    return backedCredits(bal.amountGhs, rate)
  } catch (e: any) {
    console.error("[SMS-WHOLESALE] supply unknown — failing closed:", e?.message ?? e)
    return 0
  }
}
