// lib/cashback/buyer-share.ts
// Per-role cashback buyer share. System slugs (dealer/user) use today's shares directly: no roles / rates read,
// no new failure mode (returns undefined, the pure quoteCashback path). A custom role resolves:
// ladder row cashback_share:<serviceKey> -> ladder row cashback_share:<group> -> ladder legacy (reaching dealer =
// dealer share, reaching user = customer share, same walk as airtime fees and package prices).
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

// Service keys resolve with NaN legacy: "no ladder row found" (a real row is always finite), so a missing service
// row falls through to the group. Group keys resolve with sentinels (real rows are in [0,100], never negative) that
// say which legacy terminal the ladder reached; they are mapped to that service's real legacy share afterwards
// (the group key is shared by services whose per-service overrides differ).
const NO_ROW = { customer: Number.NaN, dealer: Number.NaN }
const REACHED_DEALER = -1
const REACHED_USER = -2
const GROUP_SENTINELS = { customer: REACHED_USER, dealer: REACHED_DEALER }

/**
 * Batch form: one roles read + one role_service_rates read for all services. Map value undefined = pure tier path
 * (system slug or unknown group). Precedence per service: service row (ladder) -> group row (ladder) -> ladder legacy
 * (reaching dealer on the ladder = dealer share, reaching user = customer share).
 */
export async function resolveBuyerShares(
  client: ClientLike,
  slug: string,
  serviceKeys: readonly string[],
  cfg: CashbackConfig
): Promise<Map<string, number | undefined>> {
  const out = new Map<string, number | undefined>()
  const eligible = [...new Set(serviceKeys)].filter((k) => groupOf(k) !== null)
  for (const k of serviceKeys) out.set(k, undefined)
  if (slug === "dealer" || slug === "user" || eligible.length === 0) return out
  const keyed = eligible.map((k) => ({ k, keys: cashbackShareKeys(k) }))
  const groupKeys = new Set(keyed.map((e) => e.keys.group))
  const wanted = [...new Set([...keyed.map((e) => e.keys.service), ...groupKeys])]
  const found = await serviceRatesFor(client, slug, wanted, (key) => (groupKeys.has(key) ? GROUP_SENTINELS : NO_ROW))
  for (const { k, keys } of keyed) {
    const svc = found.get(keys.service)
    if (svc !== undefined && Number.isFinite(svc)) { out.set(k, svc); continue }
    const grp = found.get(keys.group)
    const legacy = effectiveShares(cfg, k)
    if (grp === REACHED_DEALER) out.set(k, legacy.dealer)
    else if (grp === REACHED_USER) out.set(k, legacy.customer)
    else if (grp !== undefined && Number.isFinite(grp)) out.set(k, grp)
    else out.set(k, legacy.customer)
  }
  return out
}

export async function resolveBuyerShare(
  client: ClientLike,
  slug: string,
  serviceKey: string,
  cfg: CashbackConfig,
  _tierIsDealer?: boolean // unused: a custom role falls back along the ladder, not by its rule-A tier
): Promise<number | undefined> {
  return (await resolveBuyerShares(client, slug, [serviceKey], cfg)).get(serviceKey)
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
