// Owner-facing base (cost) price for a package on the shop pricing pages.
// Precedence: sub-agent parent price, then the server role-resolved base map
// (/api/shop/owner-base-prices), then the public price (never cheaper).
export function ownerDisplayBase(
  pkg: { id: string; price: number | string; parent_price?: number | null },
  base: Record<string, number> | null,
): number {
  if (typeof pkg.parent_price === "number") return pkg.parent_price
  const fromServer = base?.[pkg.id]
  if (typeof fromServer === "number") return fromServer
  return Number(pkg.price) || 0
}
