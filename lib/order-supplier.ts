import { PROVIDER_DISPLAY } from "@/lib/mtn-providers/provider-display"

export type SupplierResult =
  | { kind: "supplier"; provider: string; attemptedOnly: boolean }
  | { kind: "manual" }
  | null

/** Only these statuses mean the supplier actually took the order; anything else is "only attempted". */
const HANDLED_STATUSES = new Set(["processing", "completed", "refunded", "reversed"])

function time(created_at: string | null): number {
  if (!created_at) return -Infinity
  const t = Date.parse(created_at)
  return Number.isNaN(t) ? -Infinity : t
}

/**
 * Which supplier handled an order: the most recent tracking row whose provider
 * is a known one. Unparseable timestamps sort oldest. With no usable rows, a
 * manual fulfillment method yields `manual`, anything else yields null.
 */
export function resolveSupplier(
  trackingRows: { provider: string | null; created_at: string | null }[],
  orderStatus: string | null,
  fulfillmentMethod: string | null,
): SupplierResult {
  const known = trackingRows
    .filter((r): r is { provider: string; created_at: string | null } =>
      !!r.provider && Object.prototype.hasOwnProperty.call(PROVIDER_DISPLAY, r.provider),
    )
    .sort((a, b) => time(b.created_at) - time(a.created_at))

  if (known.length > 0) {
    return {
      kind: "supplier",
      provider: known[0].provider,
      attemptedOnly: !HANDLED_STATUSES.has((orderStatus ?? "").trim().toLowerCase()),
    }
  }
  if (fulfillmentMethod === "manual") return { kind: "manual" }
  return null
}
