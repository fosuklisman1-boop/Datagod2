// lib/ussd-hubtel/confirm-note.ts
// The one extra line a data confirm screen may carry above "1. Pay now":
//   1. MTN recipient not verified -> the same warning the storefront / data packages page shows
//      (the order still goes through; delivery may wait until the number is confirmed);
//   2. otherwise, the live delivery estimate ("Delivery: ~3 min") for the order's channel.
// Both lookups are optional deps, run in parallel, and time out to "nothing to say": a slow or broken check
// never delays or blocks a purchase. The result is stored on the session, so re-showing the screen is free.
import { channelForNetwork, type DeliveryChannel } from "@/lib/delivery-estimate/query"
import type { FlowCtx } from "./flow-kit"

export const UNVERIFIED_NOTE = "Not yet verified: delivery may be delayed."
export const NOTE_TIMEOUT_MS = 2500

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
    const [verified, estimate] = await Promise.all([
      // Fail open, exactly like the web check: unknown = verified (no warning).
      verifyRecipient && opts.verify && isMtn(network) ? within(verifyRecipient(opts.recipientLocal), true) : Promise.resolve(true),
      deliveryEstimate && channel ? within(deliveryEstimate(channel), null) : Promise.resolve(null),
    ])
    return verified === false ? UNVERIFIED_NOTE : estimate
  } catch {
    return null
  }
}
