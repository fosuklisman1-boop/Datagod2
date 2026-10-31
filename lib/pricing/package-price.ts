// lib/pricing/package-price.ts
/**
 * The ONE place the data bundle price rule lives (spec: docs/superpowers/specs/2026-10-31-per-user-custom-prices-design.md).
 *
 *   role price      dealer_price when the caller is priced as a dealer and dealer_price > 0, else price
 *   effective price the user's custom price for the package when they are in 'custom' mode, else the role price
 *
 * `isDealer` is decided by each caller exactly as before (some count admins as dealers, some do not), so
 * moving a caller onto this module never changes an existing price.
 */

export type PricedPackage = {
  id: string | number
  price: number | string
  dealer_price?: number | string | null
}

/** package id -> custom price. Empty = no custom prices apply. */
export type CustomPrices = ReadonlyMap<string, number>

export const NO_CUSTOM_PRICES: CustomPrices = new Map()

export class CustomPriceReadError extends Error {
  constructor(message = "Could not read custom prices") {
    super(message)
    this.name = "CustomPriceReadError"
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function rolePrice(pkg: PricedPackage, isDealer: boolean): number {
  const dealer = pkg.dealer_price == null ? 0 : Number(pkg.dealer_price)
  return isDealer && dealer > 0 ? dealer : Number(pkg.price)
}

export function effectivePrice(pkg: PricedPackage, isDealer: boolean, custom: CustomPrices): number {
  const c = custom.get(String(pkg.id))
  return c !== undefined ? c : rolePrice(pkg, isDealer)
}

/**
 * How much less this owner pays than their role price (negative when the custom price is higher).
 * Shops sell at role price + margin; the owner's profit is margin + ownerSaving.
 */
export function ownerSaving(pkg: PricedPackage, isDealer: boolean, custom: CustomPrices): number {
  return round2(rolePrice(pkg, isDealer) - effectivePrice(pkg, isDealer, custom))
}

/** Minimal client shape (the service-role Supabase client satisfies it). */
type ClientLike = { from(table: string): any }

async function readPrices(client: ClientLike, userId: string): Promise<CustomPrices> {
  let res: { data: unknown; error: unknown }
  try {
    res = await client.from("user_package_prices").select("package_id, price").eq("user_id", userId)
  } catch {
    throw new CustomPriceReadError()
  }
  if (res.error || !Array.isArray(res.data)) throw new CustomPriceReadError()
  const out = new Map<string, number>()
  for (const row of res.data as Array<{ package_id: unknown; price: unknown }>) {
    const price = Number(row.price)
    if (row.package_id == null || !Number.isFinite(price) || price <= 0) continue
    out.set(String(row.package_id), price)
  }
  return out
}

/** Use when the caller already loaded the user's pricing_mode (saves a query). */
export async function customPricesForUser(
  client: ClientLike,
  user: { id: string; pricing_mode?: string | null } | null | undefined
): Promise<CustomPrices> {
  if (!user?.id || user.pricing_mode !== "custom") return NO_CUSTOM_PRICES
  return readPrices(client, user.id)
}

/**
 * The custom prices that apply to this user right now: empty unless users.pricing_mode = 'custom'.
 * Read fresh on every call (never cached), so an admin's change applies to the next request.
 * Throws CustomPriceReadError on any read failure: charge paths must refuse the request, never fall back.
 */
export async function getCustomPrices(client: ClientLike, userId: string | null | undefined): Promise<CustomPrices> {
  if (!userId) return NO_CUSTOM_PRICES
  let res: { data: { pricing_mode?: string } | null; error: unknown }
  try {
    res = await client.from("users").select("pricing_mode").eq("id", userId).maybeSingle()
  } catch {
    throw new CustomPriceReadError()
  }
  if (res.error) throw new CustomPriceReadError()
  return customPricesForUser(client, res.data ? { id: userId, pricing_mode: res.data.pricing_mode } : null)
}

/** Charge-path message when custom prices cannot be read. Nothing has been charged. */
export const MSG_PRICES_UNAVAILABLE = "Prices are temporarily unavailable. Please try again."
