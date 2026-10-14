import { HUBTEL_CS_SERVICES } from "../hubtel-cs/services"
import { airtimeNetId, providerEarnsCommission, type AirtimeNetId, type AirtimeProvider } from "../airtime-provider"
import type { CashbackConfig } from "./config"
import { quoteStorefront, type StorefrontQuote } from "./quote"

export interface AirtimeProviderDeps {
  /** Provider an order for `network` routes to (getAirtimeProvider bound to a client + legacy toggle). */
  getProvider: (network: string) => Promise<AirtimeProvider>
  digiwapyConfigured: () => boolean
}

export interface AirtimeCashbackTarget {
  serviceKey: `airtime_${AirtimeNetId}`
  provider: "hubtel" | "digiwapy"
  /** Largest face the provider will send in one request (Hubtel's cap), or null when uncapped. */
  maxFace: number | null
}

/**
 * The commission-earning provider an airtime order for `network` routes to, or null when none earns
 * commission (unknown network, manual, Digiwapy without its env) or Hubtel's per-request cap would
 * reject `faceAmount` after payment. Shared by the dashboard and storefront cashback quotes.
 */
export async function airtimeCashbackTarget(
  network: string,
  faceAmount: number,
  deps: AirtimeProviderDeps,
): Promise<AirtimeCashbackTarget | null> {
  const netId = airtimeNetId(network)
  if (!netId) return null
  const serviceKey = `airtime_${netId}` as const
  const provider = await deps.getProvider(network)
  if (!providerEarnsCommission(provider, deps.digiwapyConfigured())) return null
  const maxFace = provider === "hubtel" ? HUBTEL_CS_SERVICES[serviceKey].maxAmount ?? null : null
  if (maxFace !== null && faceAmount > maxFace) return null
  return { serviceKey, provider: provider as "hubtel" | "digiwapy", maxFace }
}

/** Storefront airtime cashback gate: master switch AND storefront surface AND the airtime group. */
export const storefrontAirtimeOn = (cfg: CashbackConfig): boolean =>
  cfg.enabled && cfg.surfaces.storefront && cfg.storefrontGroups.airtime

export interface StorefrontAirtimeDeps extends AirtimeProviderDeps {
  getConfig: () => Promise<CashbackConfig>
}

/**
 * Instant-cashback quote for a storefront airtime order, or null when cashback does not apply.
 * Any failure (config read, provider read) means "not applied" — the legacy storefront path runs.
 */
export async function quoteStorefrontAirtime(
  network: string,
  faceAmount: number,
  deps: StorefrontAirtimeDeps,
): Promise<StorefrontQuote | null> {
  try {
    if (!airtimeNetId(network)) return null
    const cfg = await deps.getConfig()
    if (!storefrontAirtimeOn(cfg)) return null
    const t = await airtimeCashbackTarget(network, faceAmount, deps)
    if (!t) return null
    const q = quoteStorefront({ serviceKey: t.serviceKey, provider: t.provider, faceAmount, buyer: "customer" }, cfg)
    return q.applied ? q : null
  } catch (e: any) {
    console.warn("[SHOP-AIRTIME] cashback quote unavailable, using standard pricing:", e?.message ?? e)
    return null
  }
}

/** Shop-facing storefront airtime terms for one network (public-constraints). Never exposes the shop's share. */
export interface StorefrontAirtimeTerms {
  applied: boolean
  rate: number
  share: number
  feeRate: number
  maxFace: number | null
}

const NOT_APPLIED_TERMS: StorefrontAirtimeTerms = { applied: false, rate: 0, share: 0, feeRate: 0, maxFace: null }

/**
 * Terms for the page, given a config whose storefront airtime gate the caller already checked.
 * Uses a GHS 1 probe quote: eligibility does not depend on face below the cap (rate <= 20%, shares <= 100%).
 */
export async function storefrontAirtimeTerms(
  network: string,
  cfg: CashbackConfig,
  deps: AirtimeProviderDeps,
): Promise<StorefrontAirtimeTerms> {
  try {
    if (!storefrontAirtimeOn(cfg)) return { ...NOT_APPLIED_TERMS }
    const t = await airtimeCashbackTarget(network, 1, deps)
    if (!t) return { ...NOT_APPLIED_TERMS }
    const q = quoteStorefront({ serviceKey: t.serviceKey, provider: t.provider, faceAmount: 1, buyer: "customer" }, cfg)
    if (!q.applied) return { ...NOT_APPLIED_TERMS }
    return { applied: true, rate: q.rate, share: q.share, feeRate: q.feeRate, maxFace: t.maxFace }
  } catch (e: any) {
    console.warn("[SHOP-AIRTIME] cashback terms unavailable:", e?.message ?? e)
    return { ...NOT_APPLIED_TERMS }
  }
}
