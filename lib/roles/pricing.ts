// lib/roles/pricing.ts
// The seam callers use to price by role. Pure wrappers over rolePricesFor; no extra queries.
// `AdminPricing` makes today's per-caller split explicit: some callers price admin as a dealer, some as a user.
import type { CustomPrices, PricedPackage } from "@/lib/pricing/package-price"
import { RoleReadError, rolePricesFor } from "./repo"

type ClientLike = { from(table: string): any }

export type AdminPricing = "as_user" | "as_dealer"

/** The slug whose ladder prices this role. admin -> "dealer" | "user" per rule; null/undefined/"" -> "user"; anything else unchanged. */
export function pricingSlug(role: string | null | undefined, admin: AdminPricing): string {
  if (!role) return "user"
  if (role === "admin") return admin === "as_dealer" ? "dealer" : "user"
  return role
}

/** package id (String) -> base price for every pkg. Throws RoleReadError. */
export async function roleBasePrices(
  client: ClientLike,
  role: string | null | undefined,
  pkgs: readonly PricedPackage[],
  opts: { admin: AdminPricing }
): Promise<Map<string, number>> {
  return rolePricesFor(client, pricingSlug(role, opts.admin), pkgs)
}

/** custom.get(id) ?? base.get(id); throws if neither (never 0). */
export function priceWith(
  base: ReadonlyMap<string, number>,
  pkg: { id: string | number },
  custom: CustomPrices
): number {
  const id = String(pkg.id)
  const price = custom.get(id) ?? base.get(id)
  if (price === undefined) throw new Error(`no base price for package ${id}`)
  return price
}

/** Display paths only: roleBasePrices, but on RoleReadError returns the public price map. Never use on charge paths. */
export async function roleBasePricesOrPublic(
  client: ClientLike,
  role: string | null | undefined,
  pkgs: readonly PricedPackage[],
  opts: { admin: AdminPricing }
): Promise<Map<string, number>> {
  try {
    return await roleBasePrices(client, role, pkgs, opts)
  } catch (e) {
    if (!(e instanceof RoleReadError)) throw e
    return new Map(pkgs.map((p) => [String(p.id), Number(p.price)]))
  }
}
