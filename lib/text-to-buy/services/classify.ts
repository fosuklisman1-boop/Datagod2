import type { OrderKind } from "./types"

/*
 * ussd_orders status vocabulary, read from the writers (lib/ussd/handlers/bundles.ts, lib/ussd/fulfill.ts,
 * lib/payments/charge-events.ts, lib/ussd-hubtel/order-tables.ts, lib/payments/expire-*.ts, lib/mtn-reversal.ts,
 * lib/mtn-hold.ts, migrations/20261005_order_refunds.sql, the provider sync crons):
 *   payment_status: pending | otp_required | completed | failed | expired | abandoned | cancelled | refunded
 *   order_status:   pending | processing | held_registration | completed | failed | reversed | refunding | refunded | expired | cancelled
 * Anything else is "still processing": never a failure notice.
 */
const PAYMENT_WAITING = new Set(["pending", "otp_required"])
const PAYMENT_FAILED = new Set(["failed", "expired", "abandoned", "cancelled"])
const ORDER_DELIVERY_FAILED = new Set(["failed", "reversed"])
const ORDER_REFUNDED = new Set(["refunding", "refunded"])
const ORDER_NEVER_STARTED = new Set(["failed", "expired", "cancelled"]) // with an unpaid payment: it will not be paid

/** The one place the ussd_orders two status columns become a notice decision. */
export function classifyOrder(row: { paymentStatus: string; orderStatus: string }): OrderKind {
  const pay = row.paymentStatus.trim().toLowerCase()
  const ord = row.orderStatus.trim().toLowerCase()
  if (ord === "completed") return "delivered"
  if (pay === "refunded" || ORDER_REFUNDED.has(ord)) return "refunded" // money is back or on its way: never "delayed, no need to pay again"
  if (pay === "completed") return ORDER_DELIVERY_FAILED.has(ord) ? "delivery_failed" : "paid"
  if (PAYMENT_FAILED.has(pay)) return "payment_failed"
  if (PAYMENT_WAITING.has(pay) && ORDER_NEVER_STARTED.has(ord)) return "payment_failed"
  return "waiting"
}

/*
 * airtime_orders / results_checker_orders vocabulary: the order column is `status` (pending_payment | otp_required | processing |
 * flagged | completed | failed | expired | refunding | refunded ...) beside payment_status. The ordering mirrors classifyOrder on
 * purpose: a refunded order must never reach the "payment didn't go through" notice, whatever its status column says.
 */
const STATUS_PAYMENT_WAITING = new Set(["pending", "pending_payment", "otp_required"])

/** The status-column vocabulary of the airtime and results-checker tables, same decision order as classifyOrder. */
export function classifyStatusOrder(row: { paymentStatus: string; orderStatus: string }): OrderKind {
  const pay = row.paymentStatus.trim().toLowerCase()
  const ord = row.orderStatus.trim().toLowerCase()
  if (ord === "completed") return "delivered"
  if (pay === "refunded" || ORDER_REFUNDED.has(ord)) return "refunded"
  if (pay === "completed") return ORDER_DELIVERY_FAILED.has(ord) ? "delivery_failed" : "paid" // processing, flagged, pending, anything unknown
  if (PAYMENT_FAILED.has(pay)) return "payment_failed"
  if (STATUS_PAYMENT_WAITING.has(pay) && ORDER_NEVER_STARTED.has(ord)) return "payment_failed"
  return "waiting"
}
