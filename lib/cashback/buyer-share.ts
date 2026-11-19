// lib/cashback/buyer-share.ts
// Per-role cashback buyer share. System slugs (dealer/user) use today's shares directly: no roles / rates read,
// no new failure mode (returns undefined, the pure quoteCashback path). A custom role resolves:
// ladder row cashback_share:<serviceKey> -> ladder row cashback_share:<group> -> legacy effective share.
// Throws RoleReadError on a read failure: callers keep today's semantics (cashback not applied).
import { effectiveShares, groupOf, type CashbackConfig } from "./config"
import { serviceRatesFor } from "../roles/service-rates"

type ClientLike = { from(table: string): any }

const GROUP_KEY: Record<string, string> = { airtime: "airtime", bundles: "bundles", bills: "bills" }

/** Keys in role_service_rates (0186 CHECK `^[a-z_]+:[a-z0-9_]+$`): service key normalised to [a-z0-9_]. */
export function cashbackShareKeys(serviceKey: string): { service: string; group: string } {
  const norm = String(serviceKey).toLowerCase().replace(/[^a-z0-9_]/g, "_")
  const group = groupOf(serviceKey)
  return { service: `cashback_share:${norm}`, group: `cashback_share:${group ? GROUP_KEY[group] : ""}` }
}

const NO_ROW = { customer: Number.NaN, dealer: Number.NaN }

export async function resolveBuyerShare(
  client: ClientLike,
  slug: string,
  serviceKey: string,
  cfg: CashbackConfig,
  tierIsDealer: boolean
): Promise<number | undefined> {
  if (slug === "dealer" || slug === "user") return undefined
  if (groupOf(serviceKey) === null) return undefined
  const keys = cashbackShareKeys(serviceKey)
  // NaN legacy = "no ladder row found" (a real row is always finite), so the precedence stays explicit.
  const found = await serviceRatesFor(client, slug, [keys.service, keys.group], () => NO_ROW)
  const svc = found.get(keys.service)
  if (svc !== undefined && Number.isFinite(svc)) return svc
  const grp = found.get(keys.group)
  if (grp !== undefined && Number.isFinite(grp)) return grp
  const legacy = effectiveShares(cfg, serviceKey)
  return tierIsDealer ? legacy.dealer : legacy.customer
}

export type BuyerQuoteInput = { buyer: "customer" | "dealer"; buyerShare?: number }

/**
 * Wallet-buyer input for quoteCashback from a deps object. Deps that provide getBuyerQuoteInput (production runtime)
 * resolve a custom role's share in the same call; plain getBuyerTier deps keep today's tier-only behaviour.
 * Throws on a read failure: the caller treats that as cashback not applied.
 */
export async function buyerQuoteInputFor(
  d: {
    getBuyerTier(userId: string): Promise<"customer" | "dealer">
    getBuyerQuoteInput?(userId: string, serviceKey: string, cfg: CashbackConfig): Promise<BuyerQuoteInput>
  },
  userId: string, serviceKey: string, cfg: CashbackConfig,
): Promise<BuyerQuoteInput> {
  return d.getBuyerQuoteInput ? d.getBuyerQuoteInput(userId, serviceKey, cfg) : { buyer: await d.getBuyerTier(userId) }
}
