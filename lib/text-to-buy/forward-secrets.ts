import { createHash, timingSafeEqual } from "crypto"

// Kept out of the route file: a Next route module may only export handlers and config.

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest()

/** Timing-safe equality; an unset or empty side never matches. */
export function secretMatches(given: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || !given) return false
  return timingSafeEqual(sha256(given), sha256(secret))
}

/**
 * Which line the forwarder secret in the header belongs to. All comparisons always run (no early exit on the first match);
 * the primary and main-only secrets are the main line, the shop secret is the shop line, and main wins when secrets are equal.
 */
export function resolveForwardLine(
  env: Record<string, string | undefined>,
  header: string | null | undefined,
): "main" | "shop" | null {
  const primary = secretMatches(header, env.SMS_FORWARD_SECRET)
  const mainOnly = secretMatches(header, env.SMS_FORWARD_SECRET_MAIN)
  const shop = secretMatches(header, env.SMS_FORWARD_SECRET_SHOP)
  if (primary || mainOnly) return "main"
  if (shop) return "shop"
  return null
}

/**
 * False when the shop forwarder secret is set and equals a main-line secret: the webhook then ignores the shop secret
 * (the main source wins), so the shop line would silently never receive anything. True otherwise, including when unset.
 */
export function shopSecretDistinct(env: Record<string, string | undefined>): boolean {
  const shop = env.SMS_FORWARD_SECRET_SHOP
  if (!shop) return true
  return !(shop === env.SMS_FORWARD_SECRET || shop === env.SMS_FORWARD_SECRET_MAIN)
}
