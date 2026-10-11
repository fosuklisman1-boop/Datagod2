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

const RATE_CACHE_MS = 5 * 60_000
let rateCache: { at: number; value: number | null } | null = null

/** Test helper: drop the in-process observed-rate cache. */
export function resetObservedRateCache(): void { rateCache = null }

/** maxObservedHubtelRate cached in-process for 5 minutes; only successful lookups (incl. null) are cached. */
async function cachedMaxObservedRate(): Promise<number | null> {
  if (rateCache && Date.now() - rateCache.at < RATE_CACHE_MS) return rateCache.value
  const value = await maxObservedHubtelRate()
  rateCache = { at: Date.now(), value }
  return value
}

/** Segments of messages queued but not yet sent (and not refunded) — already-sold supply. Throws on error. */
export async function queuedUnsentUnits(): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("sms_queued_unsent_units")
  if (error) throw new Error(`backlog lookup failed: ${error.message}`)
  const n = Number(data)
  if (data === null || data === undefined || !Number.isFinite(n) || n < 0) throw new Error(`backlog lookup returned ${String(data)}`)
  return n
}

export async function getWholesaleCredits(): Promise<number> {
  try {
    const routing = await getRoutingConfig()
    if (routing.primary !== "hubtel" || !hubtelConfigFromEnv()) {
      const [moolre, queued] = await Promise.all([queryMoolreSmsBalance(), queuedUnsentUnits()])
      return Math.max(0, moolre - queued)
    }

    const [bal, observed, queuedUnsent] = await Promise.all([
      fetchDisbursementBalance(), cachedMaxObservedRate(), queuedUnsentUnits(),
    ])
    if (!bal.ok) {
      console.error("[SMS-WHOLESALE] Hubtel balance unavailable — failing closed:", bal.error)
      notifyAdminsThrottled("sms_hubtel_balance_unavailable", "Hubtel balance check failing",
        `SMS credit sales are paused: ${bal.error}. Check the relay (/balance), HUBTEL_DISBURSEMENT_ACCOUNT and the IP whitelist.`).catch(() => {})
      return 0
    }
    const settings = await loadSmsSettings()
    if (bal.amountGhs < settings.hubtelLowBalanceGhs || bal.amountGhs <= 0) {
      notifyAdminsThrottled("sms_hubtel_low_balance", "Hubtel SMS balance low",
        `Hubtel Disbursement balance is GH₵${bal.amountGhs.toFixed(2)} (alert below GH₵${settings.hubtelLowBalanceGhs}). Top it up to keep selling SMS credits.`).catch(() => {})
    }
    const rate = observed ?? settings.hubtelCostPerSms
    return Math.max(0, backedCredits(bal.amountGhs, rate) - queuedUnsent)
  } catch (e: any) {
    const message = String(e?.message ?? e)
    console.error("[SMS-WHOLESALE] supply unknown — failing closed:", message)
    notifyAdminsThrottled("sms_wholesale_supply_unknown", "SMS supply check failing",
      `SMS credit sales are paused: ${message}. Check the database and the Hubtel/Moolre balance sources.`).catch(() => {})
    return 0
  }
}

export interface WholesaleSnapshot {
  provider: "hubtel" | "moolre"
  backedCredits: number
  /** Hubtel Disbursement balance in GH₵ (null for Moolre or when unreadable). */
  balanceGhs: number | null
  /** Per-SMS rate used for the Hubtel calculation. */
  ratePerSms: number | null
  /** Units already deducted from customers but not yet sent. */
  queuedUnsent: number | null
  error?: string
}

/** Pure: assemble the Hubtel snapshot from already-fetched inputs. */
export function composeHubtelSnapshot(i: {
  balance: { ok: true; amountGhs: number } | { ok: false; error: string }
  rate: number
  queued: number | null
}): WholesaleSnapshot {
  const base = { provider: "hubtel" as const, ratePerSms: i.rate }
  if (!i.balance.ok) {
    return { ...base, backedCredits: 0, balanceGhs: null, queuedUnsent: i.queued, error: `Hubtel balance unavailable: ${i.balance.error}` }
  }
  if (i.queued === null) {
    return { ...base, backedCredits: 0, balanceGhs: i.balance.amountGhs, queuedUnsent: null, error: "Queued-message count unavailable" }
  }
  return {
    ...base,
    balanceGhs: i.balance.amountGhs,
    queuedUnsent: i.queued,
    backedCredits: Math.max(0, backedCredits(i.balance.amountGhs, i.rate) - i.queued),
  }
}

/**
 * Read-only view of the supply the solvency gate sees, for the admin Supply strip. Mirrors
 * getWholesaleCredits() but sends no alerts and NEVER throws; failures come back as
 * { backedCredits: 0, error } so the UI can explain a 0. (getWholesaleCredits stays authoritative.)
 */
export async function getWholesaleSnapshot(): Promise<WholesaleSnapshot> {
  try {
    const routing = await getRoutingConfig()
    if (routing.primary === "hubtel" && hubtelConfigFromEnv()) {
      const settings = await loadSmsSettings()
      const [balance, observed, queued] = await Promise.all([
        fetchDisbursementBalance(),
        cachedMaxObservedRate().catch((e): { failed: string } => ({ failed: e instanceof Error ? e.message : String(e) })),
        queuedUnsentUnits().catch(() => null),
      ])
      if (!balance.ok) {
        return composeHubtelSnapshot({ balance, rate: settings.hubtelCostPerSms, queued })
      }
      if (observed !== null && typeof observed === "object") {
        return { provider: "hubtel", backedCredits: 0, balanceGhs: balance.amountGhs, ratePerSms: settings.hubtelCostPerSms, queuedUnsent: queued, error: `Rate lookup failed: ${observed.failed}` }
      }
      return composeHubtelSnapshot({ balance, rate: observed ?? settings.hubtelCostPerSms, queued })
    }
    const [moolre, queued] = await Promise.all([queryMoolreSmsBalance(), queuedUnsentUnits()])
    return { provider: "moolre", backedCredits: Math.max(0, moolre - queued), balanceGhs: null, ratePerSms: null, queuedUnsent: queued }
  } catch (e) {
    return { provider: "moolre", backedCredits: 0, balanceGhs: null, ratePerSms: null, queuedUnsent: null, error: e instanceof Error ? e.message : "Supply check failed" }
  }
}
