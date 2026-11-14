import { stripGhanaNumbers } from "../parse-rules"

// Words a customer writes in an order that are never a shop code (all lowercase). Network names are included.
const NOT_A_CODE = new Set([
  "mtn", "telecel", "vodafone", "voda", "airteltigo", "ishare", "bigtime", "airtel", "tigo",
  "data", "bundle", "bundles", "airtime", "credit", "recharge", "topup", "gigs", "cedis",
  "please", "pls", "plz", "send", "give", "want", "need", "buy", "with", "from", "this", "that", "number",
  "shop", "code", "shopcode", "again", "status", "help", "menu", "price", "prices", "wassce", "bece", "checker", "checkers", "voucher", "vouchers",
])

/** A word right before a token that says the token is a shop code. */
const MARKERS = new Set(["shop", "code", "from", "at", "shopcode"])

const SIZE_RE = /^\d+(?:\.\d+)?(?:gb|gigs|gig|g|mb)$/i
const AMOUNT_RE = /^(?:(?:ghs|gh|cedis?)\d+(?:\.\d+)?|\d+(?:\.\d+)?(?:ghs|gh|cedis?))$/i
const SHAPE_RE = /^[A-Za-z0-9_-]{4,20}$/
const PHONE_MARK = "\u0001"

export type ShopCandidate = { token: string; strong: boolean }

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
 * Strong on its own: mixes letters and digits, or is exactly 4 or 6 digits that the order read did not already use as a
 * size or amount (excludeTokens). Marker words and expectingCode are handled by the caller.
 */
export function isStrongToken(token: string, excludeTokens: string[] = []): boolean {
  if (/[A-Za-z]/.test(token) && /\d/.test(token)) return true
  if (/^(?:\d{4}|\d{6})$/.test(token)) return !excludeTokens.some((t) => t.trim().toLowerCase() === token.toLowerCase())
  return false
}

/**
 * The tokens of a customer text that could name a shop, in order of appearance, without repeats and keeping their case
 * (the shop lookup is exact), each marked strong or weak. Ghana phone numbers are removed first. expectingCode (the
 * customer is answering "Which shop?") makes every candidate strong.
 */
export function classifyShopCandidates(
  text: string,
  opts: { excludeTokens?: string[]; expectingCode?: boolean } = {},
): ShopCandidate[] {
  const out: ShopCandidate[] = []
  const seen = new Set<string>()
  let prev = ""
  for (const raw of stripGhanaNumbers(text, ` ${PHONE_MARK} `).split(/\s+/)) {
    const token = raw.replace(/^[^A-Za-z0-9\u0001]+|[^A-Za-z0-9\u0001]+$/g, "")
    if (!token) continue
    const afterMarker = MARKERS.has(prev)
    prev = token === PHONE_MARK ? "" : token.toLowerCase()
    if (token === PHONE_MARK || seen.has(token) || !isShopCodeCandidate(token)) continue
    seen.add(token)
    out.push({ token, strong: opts.expectingCode === true || afterMarker || isStrongToken(token, opts.excludeTokens) })
  }
  return out
}

/** Every candidate token of a text (strong and weak), in order. */
export function shopCodeCandidates(text: string): string[] {
  return classifyShopCandidates(text).map((c) => c.token)
}
