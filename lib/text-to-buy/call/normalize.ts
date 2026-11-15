import { normalizeGhanaPhone } from "@/lib/phone-format"

/**
 * A missed call's caller as a local Ghana mobile (0XXXXXXXXX), or null (short code, sender name, international, anonymous).
 * Same rule as the SMS webhook's customerPhone: digits with an optional leading +, then the shared Ghana normaliser.
 */
export function normalizeCaller(raw: string): string | null {
  const s = typeof raw === "string" ? raw.trim() : ""
  if (!/^\+?\d+$/.test(s)) return null
  return normalizeGhanaPhone(s)
}
