// lib/roles/repo.ts
// DB reads for roles + role prices. Fail closed: any read error rejects with RoleReadError, never partial data
// and never a fallback to defaults (price paths must refuse the request instead).
import type { PricedPackage } from "@/lib/pricing/package-price"
import { priceLadder, resolveRolePrice, type RolePriceMap, type RoleRow } from "./ladder"

export class RoleReadError extends Error {
  constructor(message = "Could not read roles") {
    super(message)
    this.name = "RoleReadError"
  }
}

/** Max ids per `.in()` list (PostgREST URL length / row limits). */
export const ROLE_ID_CHUNK = 500

type ClientLike = { from(table: string): any }

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

export async function loadRoles(client: ClientLike): Promise<RoleRow[]> {
  const rows = await run(() => client.from("roles").select("id, slug, rank, is_system, archived_at").limit(1000))
  return rows as RoleRow[]
}

export async function loadRolePrices(
  client: ClientLike,
  roleIds: readonly string[],
  packageIds: readonly string[]
): Promise<RolePriceMap> {
  const out = new Map<string, Map<string, number>>()
  if (roleIds.length === 0 || packageIds.length === 0) return out
  const roles = roleIds.map(String)
  for (let i = 0; i < packageIds.length; i += ROLE_ID_CHUNK) {
    const chunk = packageIds.slice(i, i + ROLE_ID_CHUNK).map(String)
    const rows = (await run(() =>
      client
        .from("role_package_prices")
        .select("role_id, package_id, price")
        .in("role_id", roles)
        .in("package_id", chunk)
        .limit(roles.length * chunk.length)
    )) as Array<{ role_id: unknown; package_id: unknown; price: unknown }>
    for (const row of rows) {
      const price = Number(row.price)
      if (row.role_id == null || row.package_id == null || !Number.isFinite(price) || price <= 0) continue
      const rid = String(row.role_id)
      let m = out.get(rid)
      if (!m) out.set(rid, (m = new Map()))
      m.set(String(row.package_id), price)
    }
  }
  return out
}

/** packageId -> price resolved for `slug` (ladder fallback, then public price). Loads only the ladder's roles' prices. */
export async function rolePricesFor(
  client: ClientLike,
  slug: string | null | undefined,
  pkgs: readonly PricedPackage[]
): Promise<Map<string, number>> {
  const roles = await loadRoles(client)
  const ladder = priceLadder(roles, slug)
  const prices =
    ladder.length === 0
      ? new Map<string, Map<string, number>>()
      : await loadRolePrices(client, ladder.map((r) => r.id), pkgs.map((p) => String(p.id)))
  const out = new Map<string, number>()
  for (const p of pkgs) out.set(String(p.id), resolveRolePrice(p, slug, roles, prices))
  return out
}
