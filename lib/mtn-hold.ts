// MTN registration gate — hold & release machinery (Phase 2).
// MTN only fulfills data to numbers pre-registered in their system
// (mtn_number_registry, Phase 1). When the gate is enabled, orders for
// unregistered numbers are HELD (status 'held_registration') instead of being
// sent to the provider (where they would just fail), and are released
// automatically once the number is marked registered.
//
// 'held_registration' is deliberately NOT 'pending': the admin manual-fulfill
// queue and verify-pending-payments both select 'pending', so a held order is
// invisible to them by construction (no doomed provider pushes).
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export const HOLD_STATUS = "held_registration"

export const MTN_ORDER_TABLES = [
  "orders",
  "shop_orders",
  "api_orders",
  "ussd_orders",
  "ussd_shop_orders",
] as const
export type MtnOrderTable = (typeof MTN_ORDER_TABLES)[number]

/** Status column per table (same mapping as lib/fulfillment-service.ts). */
export function statusColumnFor(table: MtnOrderTable): "status" | "order_status" {
  return table === "orders" || table === "api_orders" ? "status" : "order_status"
}

/**
 * Pure gate decision. Hold iff the gate is enabled AND the registry does not
 * say 'registered' (missing row counts as not registered).
 */
export function decideMtnGate(
  gateEnabled: boolean,
  registryStatus: string | null
): { hold: boolean } {
  if (!gateEnabled) return { hold: false }
  return { hold: registryStatus !== "registered" }
}
