// lib/pricing/user-package-prices.ts
// Client-side reading of GET /api/user/package-prices (display only; order routes re-price on the server).
import { applyAdjustmentsExceptCustom } from "./adjust-except-custom"
import { rolePrice, type PricedPackage } from "./package-price"

export type UserPackagePrices = { prices: Record<string, number>; custom_ids: string[] }

/** Shown when the resolved prices could not be loaded and role prices are displayed instead. */
export const MSG_STANDARD_PRICES_FALLBACK = "Showing standard prices; your latest prices could not be loaded."
/** Shared toast id: the data packages page and the bulk form inside it show the notice once, not twice. */
export const STANDARD_PRICES_TOAST_ID = "standard-prices-fallback"

/** Validates the endpoint's JSON body. null when it is not the expected shape. */
export function parseUserPackagePrices(body: unknown): UserPackagePrices | null {
  const b = body as { prices?: unknown; custom_ids?: unknown } | null
  if (!b || typeof b.prices !== "object" || b.prices === null || Array.isArray(b.prices)) return null
  const prices: Record<string, number> = {}
  for (const [id, v] of Object.entries(b.prices as Record<string, unknown>)) {
    const n = Number(v)
    if (v != null && Number.isFinite(n)) prices[id] = n
  }
  const custom_ids = Array.isArray(b.custom_ids) ? b.custom_ids.map(String) : []
  return { prices, custom_ids }
}

/** Fetches the signed-in user's resolved prices. null on any failure (no token, HTTP error, bad body). */
export async function fetchUserPackagePrices(
  accessToken: string | null | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<UserPackagePrices | null> {
  if (!accessToken) return null
  try {
    const res = await fetchImpl("/api/user/package-prices", {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    })
    if (!res.ok) return null
    return parseUserPackagePrices(await res.json())
  } catch {
    return null
  }
}

/**
 * Applies the resolved prices to packages. With no resolved prices (`null`), falls back to the role price
 * for `isDealer` and reports `fallback: true` so the page can say so. A package missing from the resolved
 * map (e.g. it became unavailable meanwhile) also shows its role price.
 * Custom prices are exact: callers must not apply display adjustments to `customIds`.
 */
export function resolveDisplayPrices<T extends PricedPackage>(
  packages: T[],
  resolved: UserPackagePrices | null,
  isDealer: boolean
): { packages: Array<T & { price: number }>; customIds: string[]; fallback: boolean } {
  if (!resolved) {
    return { packages: packages.map((p) => ({ ...p, price: rolePrice(p, isDealer) })), customIds: [], fallback: true }
  }
  return {
    packages: packages.map((p) => {
      const r = resolved.prices[String(p.id)]
      return { ...p, price: r != null ? r : rolePrice(p, isDealer) }
    }),
    customIds: resolved.custom_ids,
    fallback: false,
  }
}

/**
 * Bulk order form pricing: resolveDisplayPrices, then the per-network display adjustment ONLY where the shown
 * price is the plain `price` (a non-dealer's role price, or a dealer's when dealer_price is unset or 0).
 * Dealer prices and custom prices are shown unadjusted, exactly what /api/orders/create-bulk charges.
 * Same rules on the fallback path.
 */
export async function priceBulkFormPackages<T extends PricedPackage>(
  packages: T[],
  resolved: UserPackagePrices | null,
  isDealer: boolean,
  adjust: (pkgs: Array<T & { price: number }>) => Promise<Array<T & { price: number }>>
): Promise<{ packages: Array<T & { price: number }>; fallback: boolean }> {
  const { packages: priced, customIds, fallback } = resolveDisplayPrices(packages, resolved, isDealer)
  const custom = new Set(customIds.map(String))
  const unadjusted = packages
    // The role price is dealer_price exactly when the user is a dealer and dealer_price > 0 (see rolePrice).
    .filter((p) => custom.has(String(p.id)) || (isDealer && Number(p.dealer_price) > 0))
    .map((p) => String(p.id))
  return { packages: await applyAdjustmentsExceptCustom(priced, unadjusted, adjust), fallback }
}
