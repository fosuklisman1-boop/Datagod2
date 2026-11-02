// lib/ussd-hubtel/confirm-note.ts
// The one extra line a data confirm screen may carry above "1. Pay now":
//   1. MTN recipient not verified -> the same warning the storefront / data packages page shows
//      (the order still goes through; delivery may wait until the number is confirmed);
//      With the admin blocking toggle on, a rejected number gets RECIPIENT_BLOCKED_NOTE instead and the
//      caller re-prompts for another number (see blockedRecipientScreen);
//   2. otherwise, the live delivery estimate ("Delivery: ~3 min") for the order's channel.
// Both lookups are optional deps, run in parallel, and time out to "nothing to say": a slow or broken check
// never delays or blocks a purchase. The result is stored on the session, so re-showing the screen is free.
import { channelForNetwork, type DeliveryChannel } from "@/lib/delivery-estimate/query"
import type { FlowCtx } from "./flow-kit"

export const UNVERIFIED_NOTE = "Not yet verified: delivery may be delayed."
export const RECIPIENT_BLOCKED_NOTE = "Number not verified for MTN data. Enter a different number."
export const NOTE_TIMEOUT_MS = 2500
/** How long "1. Pay now" waits on the recipient check before failing open (usually a cache hit). */
export const PAY_GATE_TIMEOUT_MS = 4000

function within<T>(p: Promise<T>, fallback: T, ms = NOTE_TIMEOUT_MS): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))])
}

const isMtn = (network: string | undefined) => (network ?? "").trim().toLowerCase() === "mtn"

/**
 * `verify`: run the MTN number check (supplier-fulfilled data only; Standard Bundles have their own suppliers).
 * `estimate`: which delivery-estimate channel to show; "network" = the data network's own channel.
 */
export async function confirmNote(ctx: FlowCtx, opts: {
  network: string | undefined; recipientLocal: string; verify: boolean; estimate: "network" | DeliveryChannel | null
}): Promise<string | null> {
  const { verifyRecipient, deliveryEstimate } = ctx.deps
  const network = opts.network
  const channel = opts.estimate === "network" ? channelForNetwork(network) : opts.estimate
  try {
    const check = verifyRecipient && opts.verify && isMtn(network) ? verifyRecipient(opts.recipientLocal) : null
    let settled = check === null
    check?.then(() => { settled = true }, () => { settled = true })
    const [verified, estimate] = await Promise.all([
      // Fail open, exactly like the web check: unknown = verified (no warning).
      check ? within(check, true) : Promise.resolve(true),
      deliveryEstimate && channel ? within(deliveryEstimate(channel), null) : Promise.resolve(null),
    ])
    // Gave up waiting: let the check finish after the reply so its verdict is cached for "Pay now".
    if (check && !settled) ctx.deps.defer?.(() => check.catch(() => undefined))
    if (verified === "blocked") return RECIPIENT_BLOCKED_NOTE
    return verified === false ? UNVERIFIED_NOTE : estimate
  } catch {
    return null
  }
}

/**
 * The hard gate at "1. Pay now", before Hubtel takes payment: true only for an MTN recipient the check
 * blocks (admin toggle on). Usually answered from the verdict cached at the recipient step; waits at most
 * PAY_GATE_TIMEOUT_MS and fails open on a slow or broken check.
 */
export async function recipientBlockedAtPay(ctx: FlowCtx, network: string | undefined, recipientLocal: string | undefined): Promise<boolean> {
  const { verifyRecipient } = ctx.deps
  if (!verifyRecipient || !recipientLocal || !isMtn(network)) return false
  return (await within(verifyRecipient(recipientLocal), true, PAY_GATE_TIMEOUT_MS)) === "blocked"
}
