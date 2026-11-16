/**
 * Storefront order confirmation SMS text. Pure (no I/O) so it can be unit-tested.
 *
 * HARD RULE: the result is always ONE SMS segment (one credit when the shop bills it to its own
 * sender ID). The shop link is what varies in length, so it is degraded step by step:
 *   1. "Buy again: https://<sub>.<root>"   (tappable on every phone)
 *   2. "Buy again: <sub>.<root>"           (most phones still auto-link it)
 *   3. no link                              (confirmation is never lost or split)
 */
import { calculateSegments } from "./segments"

export interface ShopOrderConfirmationInput {
  /** Already colour-mapped network name, e.g. "Yellow" (see networkColor in lib/sms-service). */
  networkLabel: string
  volume: string
  phone: string
  ownerPhone: string
  /** user_shops.subdomain; anything that isn't a plain DNS label means "no link". */
  subdomain?: string | null
  rootDomain: string
}

// A single DNS label: letters, digits, hyphens (no dots/slashes, so no smuggled foreign host).
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export function buildShopOrderConfirmation(input: ShopOrderConfirmationInput): string {
  const core = `Order placed: ${input.networkLabel} ${input.volume}G.B to ${input.phone}. Delayed over 2hrs? Call ${input.ownerPhone}.`

  const sub = (input.subdomain ?? "").trim().toLowerCase()
  if (!SUBDOMAIN_RE.test(sub)) return core

  const host = `${sub}.${input.rootDomain}`
  for (const link of [`https://${host}`, host]) {
    const msg = `${core} Buy again: ${link}`
    if (calculateSegments(msg).segments === 1) return msg
  }
  return core
}
