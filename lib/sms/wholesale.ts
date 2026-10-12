/**
 * Backed SMS supply for the solvency gate (spec §5.5a). credit_sms_units_if_solvent only
 * issues credits while all balances + this purchase stay ≤ this number, so it must fail
 * CLOSED (0) whenever the real supply is unknown.
 *   Hubtel primary → Disbursement balance (GH₵) ÷ highest per-SMS rate seen in 7 days
 *                    (admin setting sms_hubtel_cost_per_sms until any rate is observed).
 *                    The balance comes from resolveHubtelBalance(): the relay /balance, else a
 *                    manual balance (< 30 days old) minus the Hubtel spend recorded since it was set.
 *   otherwise      → Moolre wholesale credit balance (unchanged behaviour)
 */
import { createClient } from "@supabase/supabase-js"
import { getRoutingConfig } from "./routing"
import { hubtelConfigFromEnv } from "./providers/hubtel"
import { fetchDisbursementBalance } from "@/lib/ussd-hubtel/relay"
import { queryMoolreSmsBalance } from "@/lib/sms-service"
import { loadSmsSettings, type SmsPlatformSettings } from "./platform-settings"
import { notifyAdminsThrottled } from "./notify"
import { isManualBalanceFresh, manualEstimate, type HubtelManualBalance } from "./hubtel-manual-balance"

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

/**
 * Exact GH₵ spent on Hubtel SMS since `sinceIso` (migration 20261020). Throws on a query error or
 * an unusable value: the caller must treat that as "balance unavailable", never as "nothing spent".
 */
export async function hubtelSpendSince(sinceIso: string, defaultRate: number): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("sms_hubtel_spend_since", { p_since: sinceIso, p_default_rate: defaultRate })
  if (error) throw new Error(`Hubtel spend lookup failed: ${error.message}`)
  const n = typeof data === "number" ? data : typeof data === "string" && data.trim() !== "" ? Number(data) : NaN
  if (!Number.isFinite(n) || n < 0) throw new Error(`Hubtel spend lookup returned ${String(data)}`)
  return n
}

export type HubtelBalanceResult =
  | { ok: true; amountGhs: number; source: "relay" }
  /** `preferred` is set only when the admin chose the manual balance over a working relay. */
  | { ok: true; amountGhs: number; source: "manual"; manualSetAt: string; preferred?: true }
  | { ok: false; error: string }

/** amount − Hubtel spend since setAt (floored at 0). Throws on any lookup failure. */
async function computeManualEstimate(settings: SmsPlatformSettings, mb: HubtelManualBalance): Promise<number> {
  const rate = (await cachedMaxObservedRate()) ?? settings.hubtelCostPerSms
  const spent = await hubtelSpendSince(mb.setAt, rate)
  return manualEstimate(mb.amountGhs, spent)
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Hubtel balance for the solvency gate (design 2026-10-12 §B):
 *   prefer-manual ON (sms_hubtel_prefer_manual_balance — the relay reads the Disbursement wallet, not
 *   the SMS-API wallet SMS is paid from): ONLY the manual estimate; the relay is not called. A missing,
 *   stale (≥ 30 days) or uncomputable manual balance ⇒ unavailable — never the relay figure.
 *   prefer-manual OFF (default):
 *     1. the relay /balance — when it works it wins;
 *     2. else a manual balance set < 30 days ago: amount − Hubtel spend since it was set (floored at 0),
 *        unknown per-message costs priced at the highest observed rate, else the configured cost;
 *     3. else unavailable. Any failure on the manual path (settings, rate, spend) ⇒ unavailable (fail closed).
 * Never throws.
 */
export async function resolveHubtelBalance(): Promise<HubtelBalanceResult> {
  let settings: SmsPlatformSettings
  try {
    settings = await loadSmsSettings()
  } catch (e) {
    return { ok: false, error: `SMS settings unavailable: ${msg(e)}` }
  }

  if (settings.hubtelPreferManualBalance) {
    const mb = settings.hubtelManualBalance
    if (!mb || !isManualBalanceFresh(mb)) {
      return { ok: false, error: "manual balance preferred but missing or older than 30 days — set the current Hubtel SMS balance (the relay reads a different wallet and is not used)" }
    }
    try {
      return { ok: true, amountGhs: await computeManualEstimate(settings, mb), source: "manual", manualSetAt: mb.setAt, preferred: true }
    } catch (e) {
      return { ok: false, error: `manual balance preferred but its estimate is unavailable: ${msg(e)}` }
    }
  }

  const relay = await fetchDisbursementBalance()
  if (relay.ok) return { ok: true, amountGhs: relay.amountGhs, source: "relay" }
  const mb = settings.hubtelManualBalance
  if (!mb || !isManualBalanceFresh(mb)) {
    return { ok: false, error: mb ? `${relay.error}; the manual Hubtel balance set ${mb.setAt} is older than 30 days and is ignored` : relay.error }
  }
  try {
    return { ok: true, amountGhs: await computeManualEstimate(settings, mb), source: "manual", manualSetAt: mb.setAt }
  } catch (e) {
    return { ok: false, error: `${relay.error}; manual balance estimate unavailable: ${msg(e)}` }
  }
}

export async function getWholesaleCredits(): Promise<number> {
  try {
    const routing = await getRoutingConfig()
    if (routing.primary !== "hubtel" || !hubtelConfigFromEnv()) {
      const [moolre, queued] = await Promise.all([queryMoolreSmsBalance(), queuedUnsentUnits()])
      return Math.max(0, moolre - queued)
    }

    const [bal, observed, queuedUnsent] = await Promise.all([
      resolveHubtelBalance(), cachedMaxObservedRate(), queuedUnsentUnits(),
    ])
    if (!bal.ok) {
      console.error("[SMS-WHOLESALE] Hubtel balance unavailable — failing closed:", bal.error)
      notifyAdminsThrottled("sms_hubtel_balance_unavailable", "Hubtel balance check failing",
        bal.error.startsWith("manual balance preferred")
          ? `SMS credit sales are paused: ${bal.error}. Update it in SMS Platform → Settings → "Hubtel balance (manual fallback)".`
          : `SMS credit sales are paused: ${bal.error}. Check the relay (/balance), HUBTEL_DISBURSEMENT_ACCOUNT and the IP whitelist — or, while /balance is blocked, set a manual Hubtel balance in SMS Platform → Settings → "Hubtel balance (manual fallback)".`).catch(() => {})
      return 0
    }
    const settings = await loadSmsSettings()
    if (bal.amountGhs < settings.hubtelLowBalanceGhs || bal.amountGhs <= 0) {
      const what = bal.source === "manual"
        ? `Estimated Hubtel Disbursement balance (manual estimate, set ${bal.manualSetAt}) is GH₵${bal.amountGhs.toFixed(2)}`
        : `Hubtel Disbursement balance is GH₵${bal.amountGhs.toFixed(2)}`
      notifyAdminsThrottled("sms_hubtel_low_balance", "Hubtel SMS balance low",
        `${what} (alert below GH₵${settings.hubtelLowBalanceGhs}). Top it up to keep selling SMS credits${bal.source === "manual" ? ", then set the new manual balance" : ""}.`).catch(() => {})
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
  /** Hubtel only, when a balance was obtained: the live relay reading, or the manual estimate. */
  balanceSource?: "relay" | "manual"
  /** When the manual balance behind a `manual` estimate was entered (ISO). */
  manualSetAt?: string
  /** True when the admin chose the manual balance over a working relay (the relay reads another wallet). */
  manualPreferred?: true
  error?: string
}

type SnapshotBalance =
  | { ok: true; amountGhs: number; source?: "relay" | "manual"; manualSetAt?: string; preferred?: true }
  | { ok: false; error: string }

/** Snapshot fields describing where an obtained balance came from (empty when no source given). */
function sourceFields(b: { source?: "relay" | "manual"; manualSetAt?: string; preferred?: true }): Pick<WholesaleSnapshot, "balanceSource" | "manualSetAt" | "manualPreferred"> {
  if (!b.source) return {}
  if (b.source === "relay") return { balanceSource: "relay" }
  return {
    balanceSource: "manual",
    ...(b.manualSetAt ? { manualSetAt: b.manualSetAt } : {}),
    ...(b.preferred ? { manualPreferred: true as const } : {}),
  }
}

/** Pure: assemble the Hubtel snapshot from already-fetched inputs. */
export function composeHubtelSnapshot(i: {
  balance: SnapshotBalance
  rate: number
  queued: number | null
}): WholesaleSnapshot {
  const base = { provider: "hubtel" as const, ratePerSms: i.rate }
  if (!i.balance.ok) {
    return { ...base, backedCredits: 0, balanceGhs: null, queuedUnsent: i.queued, error: `Hubtel balance unavailable: ${i.balance.error}` }
  }
  const src = sourceFields(i.balance)
  if (i.queued === null) {
    return { ...base, backedCredits: 0, balanceGhs: i.balance.amountGhs, queuedUnsent: null, ...src, error: "Queued-message count unavailable" }
  }
  return {
    ...base,
    balanceGhs: i.balance.amountGhs,
    queuedUnsent: i.queued,
    backedCredits: Math.max(0, backedCredits(i.balance.amountGhs, i.rate) - i.queued),
    ...src,
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
        resolveHubtelBalance(),
        cachedMaxObservedRate().catch((e): { failed: string } => ({ failed: e instanceof Error ? e.message : String(e) })),
        queuedUnsentUnits().catch(() => null),
      ])
      if (!balance.ok) {
        return composeHubtelSnapshot({ balance, rate: settings.hubtelCostPerSms, queued })
      }
      if (observed !== null && typeof observed === "object") {
        return { provider: "hubtel", backedCredits: 0, balanceGhs: balance.amountGhs, ratePerSms: settings.hubtelCostPerSms, queuedUnsent: queued, ...sourceFields(balance), error: `Rate lookup failed: ${observed.failed}` }
      }
      return composeHubtelSnapshot({ balance, rate: observed ?? settings.hubtelCostPerSms, queued })
    }
    const [moolre, queued] = await Promise.all([queryMoolreSmsBalance(), queuedUnsentUnits()])
    return { provider: "moolre", backedCredits: Math.max(0, moolre - queued), balanceGhs: null, ratePerSms: null, queuedUnsent: queued }
  } catch (e) {
    return { provider: "moolre", backedCredits: 0, balanceGhs: null, ratePerSms: null, queuedUnsent: null, error: e instanceof Error ? e.message : "Supply check failed" }
  }
}
