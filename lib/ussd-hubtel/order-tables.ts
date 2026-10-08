// lib/ussd-hubtel/order-tables.ts
// One entry per order table the Hubtel channel writes. Used by CONFIRM (rollback when the
// hubtel_transactions insert fails) and expiry (fail an unpaid order). Every key must be allowed by
// the order_table CHECK in migrations/0106_hubtel_ussd.sql (pinned by order-tables.test.ts).

export type HubtelOrderTable =
  | "ussd_orders" | "ussd_shop_orders" | "airtime_orders" | "results_checker_orders" | "results_check_requests" | "ussd_afa_orders"

export interface OrderTableSpec {
  /** payment_status values of an order that is still unpaid (it may yet be paid or expired). */
  payableStatuses: readonly string[]
  /** Marks an unpaid order failed (expiry, CONFIRM rollback). */
  failPatch(): Record<string, unknown>
}

const now = () => new Date().toISOString()

/**
 * AddToCart ItemName for EVERY service: "CH order <first 8 chars of the order id>", e.g.
 * "CH order 3fa85f64". Hubtel never sees a service, network, size or phone number. It depends only
 * on the order id, so the first cart and any replay of it are identical.
 */
export function cartItemNameFor(orderId: string | number): string {
  return `CH order ${String(orderId).replace(/-/g, "").slice(0, 8).toLowerCase()}`
}

export const ORDER_TABLES: Record<HubtelOrderTable, OrderTableSpec> = {
  ussd_orders: {
    payableStatuses: ["pending", "otp_required"],
    failPatch: () => ({ order_status: "failed", payment_status: "failed", updated_at: now() }),
  },
  // Shop-mode data bundles (Plan 3). Same statuses as ussd_orders.
  ussd_shop_orders: {
    payableStatuses: ["pending", "otp_required"],
    failPatch: () => ({ order_status: "failed", payment_status: "failed", updated_at: now() }),
  },
  airtime_orders: {
    payableStatuses: ["pending_payment", "otp_required"],
    failPatch: () => ({ status: "failed", payment_status: "failed", updated_at: now() }),
  },
  results_checker_orders: {
    payableStatuses: ["pending_payment", "otp_required"],
    failPatch: () => ({ status: "failed", payment_status: "failed", updated_at: now() }),
  },
  results_check_requests: {
    payableStatuses: ["pending_payment", "otp_required"],
    failPatch: () => ({ status: "failed", payment_status: "failed", updated_at: now() }),
  },
  ussd_afa_orders: {
    payableStatuses: ["pending"],
    failPatch: () => ({ order_status: "failed", payment_status: "failed", updated_at: now() }),
  },
}

export function isHubtelOrderTable(t: string): t is HubtelOrderTable {
  return Object.prototype.hasOwnProperty.call(ORDER_TABLES, t)
}
