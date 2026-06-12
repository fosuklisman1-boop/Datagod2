// Single source of truth for Ghana mobile-number parsing/validation.
//
// Multiple flows (signup, update-phone, the phone gate, withdrawal validation,
// the admin phone-audit) used to each carry their own regex/normalizer, which
// drifted apart. Centralise it here so "is this a valid Ghana number?" and
// "what is its canonical form?" mean exactly one thing everywhere.
//
// Ghana mobile numbers are 9 significant digits beginning [2-9] (the leading 0
// of the local 0XXXXXXXXX form, or the 233 country code, is a prefix). Canonical
// form we store/compare on is the local 10-digit `0XXXXXXXXX`.

/** Strip everything except digits. */
export function digitsOnly(phone: string): string {
  return (phone || "").replace(/\D/g, "")
}

/**
 * Reduce any accepted format to the 9 significant digits (no leading 0 / 233 /
 * +233), or null if it doesn't look like a Ghana mobile number.
 */
export function ghanaSignificant(phone: string): string | null {
  if (!phone) return null
  let d = digitsOnly(phone)
  if (d.startsWith("233")) d = d.slice(3)
  else if (d.startsWith("0")) d = d.slice(1)
  // After stripping the prefix we expect exactly 9 digits starting [2-9].
  if (!/^[2-9]\d{8}$/.test(d)) return null
  return d
}

/** True only for a plausible Ghana mobile number in any accepted format. */
export function isValidGhanaMobile(phone: string): boolean {
  return ghanaSignificant(phone) !== null
}

/**
 * Canonical local form `0XXXXXXXXX` (10 digits), or null if invalid. Use this on
 * every WRITE so the same human number can't be stored two ways (which would
 * defeat per-phone uniqueness and the verification lookups).
 */
export function normalizeGhanaPhone(phone: string): string | null {
  const sig = ghanaSignificant(phone)
  return sig ? "0" + sig : null
}

/**
 * All the stored representations a given number might appear as, so a lookup
 * matches however it was historically saved (mixed formats predate
 * normalisation). Includes the raw input as a fallback for non-Ghana legacy rows.
 */
export function phoneVariants(phone: string): string[] {
  const sig = ghanaSignificant(phone)
  const out = new Set<string>([phone])
  if (sig) {
    out.add("0" + sig)        // 0XXXXXXXXX
    out.add(sig)              // XXXXXXXXX
    out.add("233" + sig)      // 233XXXXXXXXX
    out.add("+233" + sig)     // +233XXXXXXXXX
  } else {
    // Best-effort variants for anything that isn't a clean Ghana mobile.
    const digits = digitsOnly(phone)
    const local = digits.startsWith("233") ? "0" + digits.slice(3) : (digits.startsWith("0") ? digits : "0" + digits)
    const noZero = local.replace(/^0/, "")
    for (const v of [local, noZero, "233" + noZero, "+233" + noZero]) out.add(v)
  }
  return Array.from(out)
}
