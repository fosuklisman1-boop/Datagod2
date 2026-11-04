/**
 * Money rules for dealer upgrades.
 *
 * The price check in /api/payments/initialize tries `orderId` before `type: "dealer_upgrade"`, so an
 * upgrade sent with an orderId was priced from that order. The Paystack webhook then compared the
 * payment with wallet_payments.amount (that same order price) and granted the plan named in the
 * metadata. `orderType: "dealer_upgrade"` reached the same grant while skipping the upgrade checks,
 * because the webhook also treats that row label as an upgrade. These rules refuse both at the start.
 */

export type UpgradeInitCheck = { ok: true } | { ok: false; status: 400 | 401; error: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A dealer upgrade must say so in `type`, name one plan by id, come from a logged-in user, and have
 * no order attached. Requests that don't involve an upgrade pass straight through.
 */
export function checkUpgradeInitRequest(req: {
  type?: unknown
  orderType?: unknown
  orderId?: unknown
  planId?: unknown
  userId?: string
}): UpgradeInitCheck {
  const isUpgrade = req.type === "dealer_upgrade"
  if (!isUpgrade && req.orderType !== "dealer_upgrade") return { ok: true }
  if (!isUpgrade || req.orderId) return { ok: false, status: 400, error: "Invalid upgrade request" }
  if (typeof req.planId !== "string" || !UUID.test(req.planId)) {
    return { ok: false, status: 400, error: "Please choose a subscription plan" }
  }
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
