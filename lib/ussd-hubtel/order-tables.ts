// lib/ussd-hubtel/order-tables.ts
// One entry per order table the Hubtel channel writes. Used by CONFIRM (rollback when the
// hubtel_transactions insert fails), replay (rebuild the identical AddToCart from the stored
// order), and expiry (fail an unpaid order). Every key must be allowed by the order_table CHECK
// in migrations/0106_hubtel_ussd.sql (pinned by order-tables.test.ts).
import { HUBTEL_NETWORKS, airtimeLabel, formatSize } from "./menus"

export type HubtelOrderTable = "ussd_orders" | "airtime_orders"

export interface OrderTableSpec {
  /** payment_status values of an order that is still unpaid (it may yet be paid or expired). */
  payableStatuses: readonly string[]
  /** Marks an unpaid order failed (expiry, CONFIRM rollback). */
  failPatch(): Record<string, unknown>
  /** Columns cartItemName needs; read back from the order on replay. */
  cartColumns: string
  /** AddToCart ItemName, built from the order row so a replay is identical to the first cart. */
  cartItemName(row: Record<string, unknown>): string
}

const now = () => new Date().toISOString()

export const ORDER_TABLES: Record<HubtelOrderTable, OrderTableSpec> = {
  ussd_orders: {
    payableStatuses: ["pending", "otp_required"],
    failPatch: () => ({ order_status: "failed", payment_status: "failed", updated_at: now() }),
    cartColumns: "package_size, network",
    cartItemName: r => {
      const label = HUBTEL_NETWORKS.find(n => n.dbName === r.network)?.label ?? String(r.network)
      return `${formatSize(String(r.package_size))} ${label} Data`
    },
  },
  airtime_orders: {
    payableStatuses: ["pending_payment", "otp_required"],
    failPatch: () => ({ status: "failed", payment_status: "failed", updated_at: now() }),
    cartColumns: "network, beneficiary_phone",
    cartItemName: r => `${airtimeLabel(String(r.network))} Airtime to ${r.beneficiary_phone}`,
  },
}

export function isHubtelOrderTable(t: string): t is HubtelOrderTable {
  return Object.prototype.hasOwnProperty.call(ORDER_TABLES, t)
}
