import { UNCONFIRMED_PAYMENT_MESSAGE } from "@/lib/bills/ui-helpers"
import { digitsOnly, ghanaSignificant, normalizeGhanaPhone, validateNetworkPrefix, type NetworkPrefixMap } from "@/lib/phone-format"

export const BUNDLE_CHANGED_MESSAGE = "This bundle changed - please refresh and pick it again."
export const BUNDLE_UNCONFIRMED_MESSAGE = UNCONFIRMED_PAYMENT_MESSAGE
export const NOT_CHARGED_FAILED_MESSAGE = "Purchase failed. You were not charged."
export const MAYBE_CHARGED_FAILED_MESSAGE = "Purchase failed. If you were charged, a refund will follow."
export const NOT_YET_PAID_MESSAGE = "Your payment has not gone through yet and you have not been charged. Tap Buy to finish."

/** Format money the same way everywhere on the Standard Bundles page. */
export const formatGhs = (n: number): string => `GHS ${Number(n).toFixed(2)}`

export type BuyOutcome =
  | { kind: "done"; reference: string; status: string }
  | { kind: "refresh"; message: string }
  | { kind: "insufficient"; message: string }
  | { kind: "retry"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "unconfirmed"; message: string }

/** The admin-editable prefix map + its on/off toggle, as served by /api/network-prefixes. */
export type PrefixRules = { enabled: boolean; map: NetworkPrefixMap }

/** Parses a /api/network-prefixes body. Returns null when it is not usable (the caller then skips the prefix check). */
export function parsePrefixRules(json: unknown): PrefixRules | null {
  const j = json as { enabled?: unknown; map?: Record<string, unknown> } | null
  const m = j?.map
  if (!m || typeof m !== "object") return null
  const nets = ["MTN", "TELECEL", "AT"] as const
  for (const n of nets) {
    const v = m[n]
    if (!Array.isArray(v) || !v.every(p => typeof p === "string")) return null
  }
  return { enabled: j?.enabled !== false, map: { MTN: m.MTN as string[], TELECEL: m.TELECEL as string[], AT: m.AT as string[] } }
}

/**
 * Client-side recipient check for the chosen network. Returns an error message, or null when OK.
 * The prefix check runs only with the live admin rules and only when they are switched on; without them (still
 * loading, or the fetch failed) only the basic number shape is checked and the server stays authoritative.
 */
export function validateBundleRecipient(network: string, phone: string, rules: PrefixRules | null | undefined): string | null {
  const trimmed = phone.trim()
  if (!trimmed) return "Enter the recipient's phone number."
  if (!normalizeGhanaPhone(trimmed)) return "Please enter a valid Ghana mobile number."
  if (!rules || !rules.enabled) return null
  const check = validateNetworkPrefix(network, trimmed, rules.map)
  return check.ok ? null : check.message
}

const withNotCharged = (m: string) => `${m.endsWith(".") ? m : m + "."} You were not charged.`

/**
 * Classifies a /api/standard-bundles/buy response.
 * - 4xx answers are deliberate rejections; none of them follows a debit, so their message is shown as is.
 * - Orders the server reports as `unpaid` were never charged, and the message says so (never "refund will follow").
 * - Anything else that is not a deliberate, known answer (timeouts, crashes, non-JSON 5xx, network errors) is
 *   "unconfirmed", never "failed": the wallet may already have been debited.
 */
export function classifyBuyResponse(status: number, json: any): BuyOutcome {
  const apiMsg = typeof json?.error === "string" && json.error ? json.error : ""
  const order = json?.order
  const neverCharged = order?.payment_status === "unpaid"
  if (status === 200 && json?.success) {
    const st = String(order?.status ?? "processing")
    if (st === "failed") return { kind: "failed", message: neverCharged ? NOT_CHARGED_FAILED_MESSAGE : MAYBE_CHARGED_FAILED_MESSAGE }
    // A replay of an order that was never paid: keep the key and let the customer tap Buy to resume it.
    if (neverCharged) return { kind: "retry", message: NOT_YET_PAID_MESSAGE }
    return { kind: "done", reference: String(order?.reference_code ?? ""), status: st }
  }
  if (status === 409) return { kind: "refresh", message: apiMsg || BUNDLE_CHANGED_MESSAGE }
  if (status === 402) return { kind: "insufficient", message: withNotCharged(apiMsg || "Insufficient wallet balance") }
  if (status === 503 || status === 429) return { kind: "retry", message: apiMsg || "Temporarily unavailable. Please try again shortly." }
  // A deliberate service answer that carries an order the server has marked failed.
  if (status !== 0 && order?.status === "failed" && apiMsg) {
    return { kind: "failed", message: neverCharged ? withNotCharged(apiMsg) : apiMsg }
  }
  if (status >= 400 && status < 500) return { kind: "failed", message: apiMsg || "Something went wrong. Please try again." }
  return { kind: "unconfirmed", message: BUNDLE_UNCONFIRMED_MESSAGE }
}

/**
 * True only after a DEFINITE non-delivery. Uncertain outcomes (timeout/network error = status 0 or null,
 * 5xx, unparseable 2xx, pending/processing orders) keep the key so a retry dedupes server-side.
 * 429/503 are rejected before any order exists (or leave it unpaid for a resume), so we keep the key.
 */
export function shouldRotateIdempotencyKey(httpStatus: number | null, json: any): boolean {
  if (httpStatus === null || httpStatus === 0) return false
  if (json?.order?.status === "failed") return true
  if (httpStatus === 429) return false
  return httpStatus >= 400 && httpStatus < 500
}

/** Identity of a recipient for key purposes: the 233 form when it is a Ghana mobile, else its raw digits. */
export function recipientIdentity(phone: string): string {
  const sig = ghanaSignificant(phone)
  return sig ? "233" + sig : "raw:" + digitsOnly(phone)
}

/**
 * The idempotency key to use after the phone field changes. Reformatting the same number (024… -> 233…) keeps the
 * key; going back to the number of the last attempt restores that attempt's key (so a retry after an unconfirmed
 * result dedupes instead of debiting twice); a genuinely different number gets a new key.
 */
export function keyAfterPhoneEdit(a: {
  prevPhone: string
  nextPhone: string
  currentKey: string
  lastAttempt: { recipient: string; key: string } | null
  newKey: () => string
}): string {
  const next = recipientIdentity(a.nextPhone)
  if (a.lastAttempt && next === a.lastAttempt.recipient) return a.lastAttempt.key
  if (next === recipientIdentity(a.prevPhone)) return a.currentKey
  return a.newKey()
}

/** Catalog tokens expire after 10 minutes; refetch a little earlier. */
export const CATALOG_MAX_AGE_MS = 9 * 60_000

export function isCatalogStale(fetchedAt: number | null, now: number): boolean {
  return fetchedAt === null || now < fetchedAt || now - fetchedAt >= CATALOG_MAX_AGE_MS
}

type BundleLike = { value: string; amount: number; category: string }

/** The same bundle (exact value, amount at 2dp, category) in a freshly loaded catalog, or null if it is gone. */
export function findSameBundle<B extends BundleLike>(categories: { bundles: B[] }[], b: BundleLike): B | null {
  for (const c of categories) {
    for (const x of c.bundles) {
      if (x.value === b.value && x.category === b.category && Math.round(x.amount * 100) === Math.round(b.amount * 100)) return x
    }
  }
  return null
}

export function bundleStatusLabel(status: string, paymentStatus: string): { label: string; tone: string } {
  if (paymentStatus === "unpaid") {
    if (status === "pending") return { label: "Not charged", tone: "muted" }
    if (status === "failed") return { label: "Failed - not charged", tone: "failed" }
  }
  if (status === "pending" || status === "processing") return { label: "Processing", tone: "processing" }
  return { label: status.charAt(0).toUpperCase() + status.slice(1), tone: status }
}
