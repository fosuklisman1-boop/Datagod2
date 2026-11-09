// lib/ussd-hubtel/order-tables.ts
// One entry per order table the Hubtel channel writes. Used by CONFIRM (rollback when the
// hubtel_transactions insert fails) and expiry (fail an unpaid order). Every key must be allowed by
// the order_table CHECK on hubtel_transactions: migrations/0106_hubtel_ussd.sql, widened by
// migrations/0125_hubtel_ussd_bot_orders.sql (pinned by order-tables.test.ts).
import type { SupabaseClient } from "@supabase/supabase-js"
import { safeDbError } from "./log-safe"
import { readSpecialGroup } from "./special-group"

export type HubtelOrderTable =
  | "ussd_orders" | "ussd_shop_orders" | "airtime_orders" | "results_checker_orders" | "results_check_requests" | "ussd_afa_orders"
  | "hubtel_bill_orders" | "hubtel_data_orders"

export interface OrderTableSpec {
  /** payment_status values of an order that is still unpaid (it may yet be paid or expired). */
  payableStatuses: readonly string[]
  /**
   * Extra column guards (`column IN values`) an expiry / "not paid" fail update must ALSO match. Used where
   * payment_status alone does not tell a still-open order (bot commission rows stay 'unpaid' once failed).
   */
  failGuards?: Readonly<Record<string, readonly string[]>>
  /** Marks an unpaid order failed (expiry, CONFIRM rollback). */
  failPatch(): Record<string, unknown>
}

/** failure_reason written on a bot commission order whose Hubtel checkout was never paid. */
export const BOT_UNPAID_FAILURE_REASON = "payment not completed"

/**
 * Commission Cashback bot orders (Utility Bills / Network Plans) paid through the Hubtel USSD checkout. Only
 * channel 'bots' rows that are still pending and unpaid may be failed; payment_status stays 'unpaid' (an unpaid
 * failed row is never refundable or dispatched).
 */
const BOT_COMMISSION_SPEC: OrderTableSpec = {
  payableStatuses: ["unpaid"],
  failGuards: { channel: ["bots"], status: ["pending"] },
  failPatch: () => ({ status: "failed", failure_reason: BOT_UNPAID_FAILURE_REASON, updated_at: now() }),
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
  // Commission Cashback bot orders (Bots Plan 2). Created by the engine, paid through the Hubtel checkout.
  hubtel_bill_orders: BOT_COMMISSION_SPEC,
  hubtel_data_orders: BOT_COMMISSION_SPEC,
}

export function isHubtelOrderTable(t: string): t is HubtelOrderTable {
  return Object.prototype.hasOwnProperty.call(ORDER_TABLES, t)
}

/**
 * Mark an order failed with its table's fail patch plus the table's guards, so only a still-open row is touched.
 * `engine` (an engine-created order: not ours, the engine may hand back an existing row) also guards on a payable
 * payment_status, as guardedFailUpdate in order-handlers.ts: a paid order is never failed. Never throws.
 * An engine-created hubtel_data_orders row in a Special group fails the whole group (only pending, unpaid, channel
 * 'bots' children match the guards); a group read error fails the row by id. Other tables and non-engine orders are
 * never in a group and get no extra query.
 * (Re-exported from flow-kit.ts.)
 */
export async function failOrderGuarded(
  supabase: SupabaseClient, table: HubtelOrderTable, id: string, engine: boolean, logTag: string,
): Promise<void> {
  const spec = ORDER_TABLES[table]
  try {
    let groupId: string | null = null
    if (engine && table === "hubtel_data_orders") {
      try {
        groupId = (await readSpecialGroup(supabase, table, id))?.groupId ?? null
      } catch (e) {
        console.error(`[${logTag}] Special group read failed; failing the order by id:`, id, safeDbError(e))
      }
    }
    let q = supabase.from(table).update(spec.failPatch()).eq(groupId ? "special_group_id" : "id", groupId ?? id)
    if (engine) q = q.in("payment_status", [...spec.payableStatuses])
    for (const [column, values] of Object.entries(spec.failGuards ?? {})) q = q.in(column, [...values])
    const { error } = await q
    if (error) console.error(`[${logTag}] Failed to mark order failed:`, id, safeDbError(error))
  } catch (e) {
    console.error(`[${logTag}] Failed to mark order failed:`, id, safeDbError(e))
  }
}
