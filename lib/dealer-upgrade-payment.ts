/**
 * Money rules for dealer upgrades.
 *
 * The price check in /api/payments/initialize tries `orderId` before `type: "dealer_upgrade"`, so an
 * upgrade sent with an orderId was priced from that order. The Paystack webhook then compared the
 * payment with wallet_payments.amount (that same order price) and granted the plan named in the
 * metadata. Both ends are closed here: such a request is refused, and the grant checks the plan.
 */

export type UpgradeInitCheck = { ok: true } | { ok: false; status: 400 | 401; error: string }

/** A dealer upgrade must be for a plan, by a logged-in user, with no order attached. */
export function checkUpgradeInitRequest(req: {
  orderId?: unknown
  planId?: unknown
  userId?: string
}): UpgradeInitCheck {
  if (req.orderId) return { ok: false, status: 400, error: "Invalid upgrade request" }
  if (!req.planId) return { ok: false, status: 400, error: "Please choose a subscription plan" }
  if (!req.userId) return { ok: false, status: 401, error: "Please sign in to upgrade your account" }
  return { ok: true }
}

const toPesewas = (ghs: number) => Math.round((ghs + Number.EPSILON) * 100)

/** True when the amount paid, not counting the fee, covers the plan's current price. */
export function isDealerUpgradeFullyPaid(p: {
  paidPesewas: number
  feeGhs: number | null | undefined
  planPriceGhs: number
}): boolean {
  const fee = p.feeGhs ?? 0
  if (!Number.isFinite(p.paidPesewas) || !Number.isFinite(fee) || !Number.isFinite(p.planPriceGhs)) return false
  return Math.round(p.paidPesewas) - toPesewas(fee) >= toPesewas(p.planPriceGhs)
}
