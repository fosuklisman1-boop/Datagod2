//
// Pure calculation for the admin "bulk update package prices" feature.
// Dependency-free (no Supabase, no fetch) so the exact same formula runs
// client-side for the live preview and server-side as the authoritative
// calculation — the preview an admin sees is guaranteed to match what the
// API will actually save, because both call this function.

export type PriceMode = "percentage" | "per_gb"

export interface FieldUpdate {
  mode: PriceMode
  value: number
}

export interface BulkPriceUpdates {
  price?: FieldUpdate
  dealer_price?: FieldUpdate
}

export interface PackagePriceInput {
  id: string
  price: number
  dealer_price: number | null
  size: string
}

export type SkipReason =
  | "non_positive_price"
  | "non_positive_dealer_price"
  | "dealer_price_exceeds_price"
  | "non_finite_value"

export interface PackagePriceResult {
  id: string
  old_price: number
  new_price: number
  old_dealer_price: number | null
  new_dealer_price: number | null
  skip_reason: SkipReason | null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function applyMode(mode: PriceMode, value: number, currentValue: number, sizeGb: number): number {
  if (mode === "per_gb") return sizeGb * value
  return currentValue * (1 + value / 100)
}

/**
 * Computes the new price/dealer_price for one package given a bulk update
 * request. Never throws — an invalid result (non-finite, <=0, or dealer >
 * price) comes back with a `skip_reason` instead, so the caller (UI preview
 * or API route) can decide what to do with it, and both sides make the same
 * decision because they call the same function.
 */
export function computePackagePriceUpdate(
  pkg: PackagePriceInput,
  updates: BulkPriceUpdates
): PackagePriceResult {
  const sizeGb = parseFloat(pkg.size) || 0

  const newPrice = updates.price
    ? round2(applyMode(updates.price.mode, updates.price.value, pkg.price, sizeGb))
    : pkg.price

  // dealer_price falls back to price as its base when unset, matching how
  // the rest of the app already treats a null dealer_price (see
  // lib/products-catalog.ts) — a dealer discount is meaningless without a
  // base to discount from.
  //
  // Deliberately `||`, not `??`: the rest of the codebase treats
  // dealer_price === 0 identically to null/undefined ("unset"), not as a
  // real zero price (see lib/products-catalog.ts's `> 0` check). `??` would
  // only fall through on null/undefined, leaving a stored 0 as the base —
  // any percentage-mode update on it then computes 0 * (1 + pct/100) = 0
  // and always trips the non_positive_dealer_price safeguard.
  const dealerBase = pkg.dealer_price || pkg.price
  const newDealerPrice = updates.dealer_price
    ? round2(applyMode(updates.dealer_price.mode, updates.dealer_price.value, dealerBase, sizeGb))
    : pkg.dealer_price

  let skip_reason: SkipReason | null = null
  if (!Number.isFinite(newPrice) || (newDealerPrice !== null && !Number.isFinite(newDealerPrice))) {
    skip_reason = "non_finite_value"
  } else if (newPrice <= 0) {
    skip_reason = "non_positive_price"
  } else if (newDealerPrice !== null && newDealerPrice <= 0) {
    skip_reason = "non_positive_dealer_price"
  } else if (newDealerPrice !== null && newDealerPrice > newPrice) {
    skip_reason = "dealer_price_exceeds_price"
  }

  return {
    id: pkg.id,
    old_price: pkg.price,
    new_price: newPrice,
    old_dealer_price: pkg.dealer_price,
    new_dealer_price: newDealerPrice,
    skip_reason,
  }
}
