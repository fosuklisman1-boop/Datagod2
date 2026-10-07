// lib/ussd-hubtel/order-tables.ts
// One entry per order table the Hubtel channel writes. Used by CONFIRM (rollback when the
// hubtel_transactions insert fails), replay (rebuild the identical AddToCart from the stored
// order), and expiry (fail an unpaid order). Every key must be allowed by the order_table CHECK
// in migrations/0106_hubtel_ussd.sql (pinned by order-tables.test.ts).
import { airtimeLabel } from "./menus"
import { formatBundleSize } from "@/lib/ussd/menus"
import { networkNickname } from "@/lib/ussd/network-labels"

export type HubtelOrderTable =
  | "ussd_orders" | "ussd_shop_orders" | "airtime_orders" | "results_checker_orders" | "results_check_requests" | "ussd_afa_orders"

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

/**
 * AddToCart ItemName for a data purchase, e.g. "5 yellow" / "2 tele" / "500 instant blue".
 * Bare size (no unit) + the shared network nickname without its trailing "Plans", lowercased —
 * the same nicknames the Uzo menus use (lib/ussd/network-labels.ts), so Hubtel never receives
 * the words "data" or "bundle". Built from the stored order row so a replay is identical.
 */
function dataCartName(r: Record<string, unknown>): string {
  const nick = networkNickname(String(r.network)).replace(/\s+plans$/i, "").trim().toLowerCase()
  return `${formatBundleSize(String(r.package_size))} ${nick}`
}

export const ORDER_TABLES: Record<HubtelOrderTable, OrderTableSpec> = {
  ussd_orders: {
    payableStatuses: ["pending", "otp_required"],
    failPatch: () => ({ order_status: "failed", payment_status: "failed", updated_at: now() }),
    cartColumns: "package_size, network",
    cartItemName: dataCartName,
  },
  // Shop-mode data bundles (Plan 3). Same statuses and cart wording as ussd_orders.
  ussd_shop_orders: {
    payableStatuses: ["pending", "otp_required"],
    failPatch: () => ({ order_status: "failed", payment_status: "failed", updated_at: now() }),
    cartColumns: "package_size, network",
    cartItemName: dataCartName,
  },
  airtime_orders: {
    payableStatuses: ["pending_payment", "otp_required"],
    failPatch: () => ({ status: "failed", payment_status: "failed", updated_at: now() }),
    cartColumns: "network, beneficiary_phone",
    cartItemName: r => `${airtimeLabel(String(r.network))} Airtime to ${r.beneficiary_phone}`,
  },
  results_checker_orders: {
    payableStatuses: ["pending_payment", "otp_required"],
    failPatch: () => ({ status: "failed", payment_status: "failed", updated_at: now() }),
    cartColumns: "exam_board, quantity",
    cartItemName: r => `${r.exam_board} Checker x${r.quantity}`,
  },
  results_check_requests: {
    payableStatuses: ["pending_payment", "otp_required"],
    failPatch: () => ({ status: "failed", payment_status: "failed", updated_at: now() }),
    cartColumns: "exam_board, mode",
    cartItemName: r => (r.mode === "combo" ? `${r.exam_board} Voucher + Results Check` : `${r.exam_board} Results Check`),
  },
  ussd_afa_orders: {
    payableStatuses: ["pending"],
    failPatch: () => ({ order_status: "failed", payment_status: "failed", updated_at: now() }),
    cartColumns: "id",
    cartItemName: () => "AFA Registration",
  },
}

export function isHubtelOrderTable(t: string): t is HubtelOrderTable {
  return Object.prototype.hasOwnProperty.call(ORDER_TABLES, t)
}
