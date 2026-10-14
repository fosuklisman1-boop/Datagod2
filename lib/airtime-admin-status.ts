/**
 * Shared guards for admin airtime status actions and provider callbacks, now that storefront airtime can be refunded
 * through /admin/refunds (statuses 'refunding' / 'refunded', migration 0120).
 */

/** The only statuses an admin "Completed" / "Failed" action (single or bulk) may move an order from. */
export const AIRTIME_ADMIN_ACTIONABLE_STATUSES = ["pending", "processing", "flagged"] as const

export const isAirtimeAdminActionable = (status: unknown): boolean =>
  typeof status === "string" && (AIRTIME_ADMIN_ACTIONABLE_STATUSES as readonly string[]).includes(status)

/** Message for a refused admin action. */
export const airtimeNotActionableMessage = (status: unknown): string =>
  status === "refunding" || status === "refunded"
    ? `Order is ${status} through /admin/refunds; it can no longer be marked completed or failed`
    : `Order is already ${String(status)}`

/**
 * Admin "Failed": only an order with a buyer account is refunded to a wallet (credit, in-app notification and the
 * "refunded to your wallet" SMS). A wallet-less order (storefront airtime, user_id NULL) has no wallet: it is
 * refunded on /admin/refunds, so nothing is credited and no refund message is sent.
 */
export const failedActionRefundsWallet = (order: { user_id?: string | null }): boolean =>
  typeof order.user_id === "string" && order.user_id.length > 0

const REFUND_STATES = new Set(["refunding", "refunded"])

/** A provider reports delivery of an order that is already being / has been refunded: double value. */
export function deliveredAfterRefund(delivered: boolean, currentStatus: unknown): boolean {
  return delivered && typeof currentStatus === "string" && REFUND_STATES.has(currentStatus)
}

export const doubleValueAlertMessage = (provider: string, reference: string, status: string): string =>
  `URGENT: double value — airtime ${reference} was delivered by ${provider} after being ${status === "refunding" ? "put into a refund" : "refunded"}. Recover the refund or the airtime; the order status was not changed.`
