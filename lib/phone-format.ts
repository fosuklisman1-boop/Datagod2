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

/** Ghana mobile network for a number, by prefix. "UNKNOWN" when the prefix
 *  isn't a recognised mobile range (callers verifying via Moolre coerce UNKNOWN
 *  to MTN, matching the admin phone-audit). Based on the first two significant
 *  digits of the canonical 0XXXXXXXXX form. */
export type GhanaNetwork = "MTN" | "TELECEL" | "AT" | "UNKNOWN"

/** Significant 2-digit prefixes per carrier. This is the SEED/default —
 *  the live map is admin-editable (admin_settings.network_prefix_map) and
 *  read server-side via lib/network-prefix-config.ts. 053 IS MTN. */
export type NetworkPrefixMap = Record<Exclude<GhanaNetwork, "UNKNOWN">, string[]>
export const DEFAULT_NETWORK_PREFIXES: NetworkPrefixMap = {
  MTN: ["24", "25", "53", "54", "55", "59"],
  TELECEL: ["20", "50"],
  AT: ["26", "27", "56", "57"],
}

export function detectNetworkWithMap(phone: string, map: NetworkPrefixMap): GhanaNetwork {
  const sig = ghanaSignificant(phone)
  if (!sig) return "UNKNOWN"
  const p = sig.slice(0, 2)
  if (map.MTN.includes(p)) return "MTN"
  if (map.TELECEL.includes(p)) return "TELECEL"
  if (map.AT.includes(p)) return "AT"
  return "UNKNOWN"
}

export function detectGhanaNetwork(phone: string): GhanaNetwork {
  return detectNetworkWithMap(phone, DEFAULT_NETWORK_PREFIXES)
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

/** Human display names for mismatch messages. */
const NETWORK_DISPLAY: Record<Exclude<GhanaNetwork, "UNKNOWN">, string> = {
  MTN: "MTN",
  TELECEL: "Telecel",
  AT: "AT",
}

/** Map an order's network string (any historical spelling) to the carrier it
 *  requires. Returns null for strings the validator doesn't understand —
 *  those are never blocked. */
export function orderNetworkToCarrier(orderNetwork: string): Exclude<GhanaNetwork, "UNKNOWN"> | null {
  const n = (orderNetwork || "").toLowerCase().trim()
  if (n === "mtn") return "MTN"
  if (n === "telecel") return "TELECEL"
  if (["at", "airteltigo", "at - ishare", "at-ishare", "ishare", "at - bigtime", "at-bigtime", "bigtime"].includes(n)) return "AT"
  return null
}

export type OrderNetworkCheck =
  | { ok: true; detected: GhanaNetwork }
  | { ok: false; detected: GhanaNetwork; message: string }

/**
 * Order-time network↔prefix validation (hard block; see spec
 * 2026-07-07-network-prefix-validation-design.md). Pure and client-safe —
 * servers pass the live admin-editable map, clients may use the default.
 */
export function validateNetworkPrefix(
  orderNetwork: string,
  phone: string,
  map: NetworkPrefixMap = DEFAULT_NETWORK_PREFIXES
): OrderNetworkCheck {
  const expected = orderNetworkToCarrier(orderNetwork)
  if (!expected) return { ok: true, detected: detectNetworkWithMap(phone, map) }

  const norm = normalizeGhanaPhone(phone)
  if (!norm) {
    return { ok: false, detected: "UNKNOWN", message: "Please enter a valid Ghana mobile number." }
  }
  const detected = detectNetworkWithMap(norm, map)
  if (detected === "UNKNOWN") {
    return {
      ok: false,
      detected,
      message: `${norm} doesn't match any Ghana mobile network — please check the number.`,
    }
  }
  if (detected !== expected) {
    return {
      ok: false,
      detected,
      message: `${norm} looks like a ${NETWORK_DISPLAY[detected]} number — check the number or switch to ${NETWORK_DISPLAY[detected]}.`,
    }
  }
  return { ok: true, detected }
}
