// lib/roles/ladder.ts
// Pure role price ladder. A role with no price for a package falls back to the next lower-ranked
// non-archived role, then to the public package price. Off-ladder roles (rank null) use only their own rows.
import type { PricedPackage } from "@/lib/pricing/package-price"

export type RoleRow = { id: string; slug: string; rank: number | null; is_system: boolean; archived_at: string | null }

/** roleId -> (packageId -> price). Only prices > 0 are ever stored. */
export type RolePriceMap = ReadonlyMap<string, ReadonlyMap<string, number>>

/**
 * The roles whose prices apply to `slug`, most specific first: the role itself, then strictly
 * lower-ranked non-archived roles by rank desc. Off-ladder role -> [itself]. Unknown/archived slug -> [].
 */
export function priceLadder(roles: readonly RoleRow[], slug: string | null | undefined): RoleRow[] {
  if (!slug) return []
  const self = roles.find((r) => r.slug === slug)
  if (!self || self.archived_at) return []
  if (self.rank == null) return [self]
  const selfRank = self.rank
  const lower = roles
    .filter((r) => r.id !== self.id && !r.archived_at && r.rank != null && r.rank < selfRank)
    .sort((a, b) => (b.rank as number) - (a.rank as number))
  return [self, ...lower]
}

/** First price found walking priceLadder(slug); else Number(pkg.price). */
export function resolveRolePrice(
  pkg: PricedPackage,
  slug: string | null | undefined,
  roles: readonly RoleRow[],
  prices: RolePriceMap
): number {
  const key = String(pkg.id)
  for (const r of priceLadder(roles, slug)) {
    const p = prices.get(r.id)?.get(key)
    if (p !== undefined && Number.isFinite(p) && p > 0) return p
  }
  return Number(pkg.price)
}
