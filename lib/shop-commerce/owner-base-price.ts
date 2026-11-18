// Owner-facing base (cost) price for a package on the shop pricing pages.
// Precedence: sub-agent parent price, then the server role-resolved base map
// (/api/shop/owner-base-prices), then the public price (never cheaper).
export function ownerDisplayBase(
  pkg: { id: string; price: number | string; parent_price?: number | null },
  base: Record<string, number> | null,
): number {
  if (Number.isFinite(pkg.parent_price)) return pkg.parent_price as number
  const fromServer = base?.[pkg.id]
  if (typeof fromServer === "number") return fromServer
  return Number(pkg.price) || 0
}

// True when a margin can be computed against a real cost: either the package
// carries a parent price, or the server base map loaded. When false the display
// falls back to the public price, which must never be persisted as a margin.
export function canPriceAgainstBase(
  pkg: object,
  base: Record<string, number> | null,
): boolean {
  return Number.isFinite((pkg as { parent_price?: unknown }).parent_price) || base !== null
}
