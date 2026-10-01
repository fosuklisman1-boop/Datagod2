// Blocks the exact wording removed from USSD copy by the 2026-09-30 "Browse
// Services" rebrand from reappearing via a shop owner's freely-settable
// shop_name. Whole-word matching (not substring) is deliberate: it avoids
// false positives like "AirtelTigoDeals" or "Databright" while still
// catching "MTN Direct" or "At Express". The bare "at" is included despite
// its own false-positive risk on short ordinary words — an accepted
// trade-off per the design spec.
export const BLOCKED_WORDS = ["data", "bundle", "bundles", "mtn", "telecel", "airteltigo", "at"]
const MAX_LENGTH = 30

export function validateUssdDisplayName(
  name: string
): { valid: true } | { valid: false; reason: string } {
  const trimmed = name.trim()
  if (!trimmed) return { valid: false, reason: "Name is required" }
  if (trimmed.length > MAX_LENGTH) {
    return { valid: false, reason: `Name must be ${MAX_LENGTH} characters or fewer` }
  }
  for (const word of BLOCKED_WORDS) {
    if (new RegExp(`\\b${word}\\b`, "i").test(trimmed)) {
      return { valid: false, reason: `Name can't contain "${word}"` }
    }
  }
  return { valid: true }
}
