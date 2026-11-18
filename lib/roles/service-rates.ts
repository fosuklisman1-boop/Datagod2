// lib/roles/service-rates.ts
// Per-role service rates (airtime fee rates, cashback shares). A role with no row falls to the next lower
// ladder role; reaching the seeded "dealer"/"user" roles with no row yields the legacy admin_settings value.
// Fail closed: any read error rejects with RoleReadError (callers decide whether to refuse or show legacy).
import { priceLadder, type RoleRow } from "./ladder"
import { loadRoles, RoleReadError, ROW_CAP } from "./repo"

export type LegacyRates = { customer: number; dealer: number }

type ClientLike = { from(table: string): any }

/** Max service keys per `.in()` list. */
export const SERVICE_KEY_CHUNK = 500

/**
 * Pure: walk priceLadder(slug); first row found wins; reaching "dealer" -> legacy.dealer;
 * reaching "user" -> legacy.customer; empty/unknown/exhausted ladder -> legacy.customer.
 */
export function resolveServiceRate(
  slug: string,
  serviceKey: string,
  roles: readonly RoleRow[],
  rows: ReadonlyMap<string, ReadonlyMap<string, number>>,
  legacy: LegacyRates
): number {
  for (const role of priceLadder(roles, slug)) {
    const v = rows.get(role.id)?.get(serviceKey)
    if (v !== undefined && Number.isFinite(v)) return v
    if (role.slug === "dealer") return legacy.dealer
    if (role.slug === "user") return legacy.customer
  }
  return legacy.customer
}

/** A tier decision + the caller's real role -> the slug to resolve with (a live custom role keeps its own slug). */
export function rateSlug(tierIsDealer: boolean, role: string | null | undefined, roles: readonly RoleRow[]): string {
  if (role) {
    const r = roles.find((x) => x.slug === role)
    if (r && !r.is_system && !r.archived_at) return r.slug
  }
  return tierIsDealer ? "dealer" : "user"
}

async function run(build: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<unknown[]> {
  let res: { data: unknown; error: unknown }
  try {
    res = await build()
  } catch {
    throw new RoleReadError()
  }
  if (!res || res.error || !Array.isArray(res.data)) throw new RoleReadError()
  return res.data
}

/** serviceKey -> rate resolved for `slug`. One roles read, then this ladder's rows chunked by key. */
export async function serviceRatesFor(
  client: ClientLike,
  slug: string,
  serviceKeys: readonly string[],
  legacy: (key: string) => LegacyRates
): Promise<Map<string, number>> {
  const roles = await loadRoles(client)
  const ladder = priceLadder(roles, slug)
  const keys = serviceKeys.map(String)
  const rows = new Map<string, Map<string, number>>()
  if (ladder.length > 0 && keys.length > 0) {
    const ids = ladder.map((r) => r.id)
    // ids x chunk must stay strictly below ROW_CAP so a legitimate response is never a full page.
    const size = Math.max(1, Math.min(SERVICE_KEY_CHUNK, Math.floor((ROW_CAP - 1) / ids.length)))
    for (let i = 0; i < keys.length; i += size) {
      const chunk = keys.slice(i, i + size)
      const data = (await run(() =>
        client
          .from("role_service_rates")
          .select("role_id, service_key, value")
          .in("role_id", ids)
          .in("service_key", chunk)
          .limit(ROW_CAP)
      )) as Array<{ role_id: unknown; service_key: unknown; value: unknown }>
      // A full page cannot be proven complete: fail closed rather than resolve from truncated data.
      if (data.length >= ROW_CAP) throw new RoleReadError()
      for (const row of data) {
        const v = Number(row.value)
        if (row.role_id == null || row.service_key == null || row.value == null || !Number.isFinite(v)) continue
        const rid = String(row.role_id)
        let m = rows.get(rid)
        if (!m) rows.set(rid, (m = new Map()))
        m.set(String(row.service_key), v)
      }
    }
  }
  const out = new Map<string, number>()
  for (const k of keys) out.set(k, resolveServiceRate(slug, k, roles, rows, legacy(k)))
  return out
}
