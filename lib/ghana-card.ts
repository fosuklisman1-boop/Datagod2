/**
 * Ghana Card number formatting + validation.
 *
 * Canonical format confirmed directly from Apex Prime's own validation
 * error message ("Ghana Card must be in the format GHA-123456789-0"):
 *   GHA-XXXXXXXXX-X   (the letters GHA, 9 digits, a dash, 1 check digit)
 */

const DIGIT_COUNT = 10

/**
 * Parses a Ghana Card number typed or pasted in any reasonable shape (with
 * or without the GHA prefix, with or without dashes/spaces) into the
 * canonical GHA-XXXXXXXXX-X form.
 *
 * Returns null when the underlying digits don't add up to exactly 10, or
 * contain anything but digits once a leading GHA is stripped — that's a
 * genuine data problem (a missing/extra digit, a mistyped letter), not a
 * formatting one, and must never be silently guessed at (e.g. inventing a
 * missing check digit, or keeping a letter that was typo'd into the number).
 */
export function parseGhanaCardNumber(raw: string): string | null {
  const stripped = String(raw ?? "").toUpperCase().replace(/[\s-]/g, "")
  const digits = stripped.startsWith("GHA") ? stripped.slice(3) : stripped
  if (!new RegExp(`^\\d{${DIGIT_COUNT}}$`).test(digits)) return null
  return `GHA-${digits.slice(0, 9)}-${digits.slice(9)}`
}

/**
 * Formats Ghana Card input AS THE USER TYPES — always anchors the literal
 * "GHA" prefix and inserts dashes at the right positions, regardless of
 * whether the user typed "GHA" themselves.
 *
 * Fixes the bug behind 4 real failed orders: the previous per-page
 * formatter assumed the first 3 *characters typed* were the letters "GHA",
 * even when a customer started by typing digits directly — scrambling the
 * result (e.g. "727791722-8" instead of "GHA-727791722-8") instead of
 * inserting the prefix for them. This version only ever extracts digit
 * characters from the input, so "GHA727791722", "727791722", and
 * "GHA-727791722" all land on the same correct result.
 */
export function formatGhanaCardInput(raw: string): string {
  const digits = String(raw ?? "").toUpperCase().replace(/[^0-9]/g, "").slice(0, DIGIT_COUNT)
  if (!digits) return ""
  const firstGroup = digits.slice(0, 9)
  const lastDigit = digits.slice(9, 10)
  return lastDigit ? `GHA-${firstGroup}-${lastDigit}` : `GHA-${firstGroup}`
}
