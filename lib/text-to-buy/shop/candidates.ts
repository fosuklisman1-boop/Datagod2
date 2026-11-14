import { stripGhanaNumbers } from "../parse-rules"

// Words a customer writes in an order that are never a shop code (all lowercase). Network names are included.
const NOT_A_CODE = new Set([
  "mtn", "telecel", "vodafone", "voda", "airteltigo", "ishare", "bigtime", "airtel", "tigo",
  "data", "bundle", "bundles", "airtime", "credit", "recharge", "topup", "gigs", "cedis",
  "please", "pls", "plz", "send", "give", "want", "need", "buy", "with", "from", "this", "that", "number",
  "again", "status", "help", "menu", "price", "prices", "wassce", "bece", "checker", "checkers", "voucher", "vouchers",
])

const SIZE_RE = /^\d+(?:\.\d+)?(?:gb|gigs|gig|g|mb)$/i
const AMOUNT_RE = /^(?:ghs|gh|cedis?)\d+(?:\.\d+)?$/i
const SHAPE_RE = /^[A-Za-z0-9_-]{4,20}$/

/** True when one token could be a shop code: 4 to 20 characters, not a size, an amount, a phone number, or an order word. */
export function isShopCodeCandidate(token: string): boolean {
  if (!SHAPE_RE.test(token)) return false
  if (SIZE_RE.test(token) || AMOUNT_RE.test(token)) return false
  if (NOT_A_CODE.has(token.toLowerCase())) return false
  // A bare Ghana number (0XXXXXXXXX, 233XXXXXXXXX): stripping it leaves nothing.
  if (stripGhanaNumbers(token).trim() === "") return false
  return true
}

/**
 * The tokens of a customer text that could name a shop, in order of appearance, without repeats and keeping their case
 * (the shop lookup is exact). Ghana phone numbers are removed first, so spaced numbers never leave fragments.
 */
export function shopCodeCandidates(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of stripGhanaNumbers(text).split(/\s+/)) {
    const token = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    if (!token || seen.has(token) || !isShopCodeCandidate(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}
