// lib/ussd/price-role.ts
// Pure price-role helpers for bot callers. The tier label ("regular" | "dealer" | "sub_agent") is unchanged and still
// stored on sessions and orders; the price role is the role-ladder slug that will price the caller (Phase 2c).
import { pricingSlug } from "@/lib/roles/pricing"

/** Today's rule for a tier label: "dealer" -> "dealer"; anything else (incl. "regular", "sub_agent", unknown) -> "user". */
export function tierToSlug(tier: string | null | undefined): string {
  return tier === "dealer" ? "dealer" : "user"
}

/** Price role for a caller: known role -> pricingSlug(role, "as_user"); unknown caller -> tierToSlug(defaultTier). */
export function buyerPriceRole(role: string | null | undefined, defaultTier: string | null | undefined): string {
  return role ? pricingSlug(role, "as_user") : tierToSlug(defaultTier)
}

/** Session/legacy-safe: priceRole if set, else tierToSlug(tier). */
export function sessionPriceRole(s: { priceRole?: string | null; effectivePriceTier?: string | null }): string {
  return s.priceRole || tierToSlug(s.effectivePriceTier)
}
