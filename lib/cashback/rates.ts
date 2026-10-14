import { groupOf, effectiveShares, type CashbackConfig } from "./config"
import { quoteCashback } from "./quote"
import type { RateEntry, RatesResponse } from "./display"
import { providerEarnsCommission, type AirtimeProvider } from "../airtime-provider"
import { HUBTEL_CS_SERVICES } from "../hubtel-cs/services"

export const NO_CASHBACK_RATES: RatesResponse = { applied: false, services: {} }
const AIRTIME_NETWORK: Record<string, string> = { airtime_mtn: "MTN", airtime_telecel: "Telecel", airtime_at: "AT" }

/**
 * The dashboard rates for one buyer tier: only services where the server would apply cashback right now.
 * Airtime entries follow the live provider (same resolution as purchaseAirtime); an unconfigured Digiwapy
 * earns nothing, so it is left out. Bundles and bills are always Hubtel.
 */
export async function buildCashbackRates(
  cfg: CashbackConfig,
  buyer: "customer" | "dealer",
  resolveAirtimeProvider: (network: string) => Promise<AirtimeProvider>,
  digiwapyConfigured: boolean,
): Promise<RatesResponse> {
  if (!cfg.enabled || !cfg.surfaces.dashboard) return NO_CASHBACK_RATES
  const services: Record<string, RateEntry> = {}
  const airtimeProviders: Record<string, AirtimeProvider> = {}
  for (const rateKey of Object.keys(cfg.rates)) {
    const [serviceKey, ratedProvider] = rateKey.split(":")
    if (!serviceKey || !ratedProvider || groupOf(serviceKey) === null) continue
    let provider: string = ratedProvider
    const network = AIRTIME_NETWORK[serviceKey]
    if (network) {
      airtimeProviders[serviceKey] ??= await resolveAirtimeProvider(network)
      provider = airtimeProviders[serviceKey]
      if (!providerEarnsCommission(airtimeProviders[serviceKey], digiwapyConfigured)) continue
    } else if (ratedProvider !== "hubtel") {
      continue
    }
    if (provider !== ratedProvider) continue
    const q = quoteCashback({ serviceKey, provider: provider as "hubtel" | "digiwapy", faceAmount: 100, buyer, channel: "dashboard" }, cfg)
    if (!q.applied) continue
    const entry: RateEntry = { provider, rate: q.rate, share: effectiveShares(cfg, serviceKey)[buyer] }
    if (network && provider === "hubtel") {
      const max = (HUBTEL_CS_SERVICES as Record<string, { maxAmount?: number }>)[serviceKey]?.maxAmount
      if (max !== undefined) entry.maxFace = max
    }
    services[serviceKey] = entry
  }
  return { applied: Object.keys(services).length > 0, services }
}
