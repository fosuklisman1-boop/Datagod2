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

/** Phone (beneficiary) column per table — same mapping as the Phase 1 capture trigger. */
export function phoneColumnFor(table: MtnOrderTable): string {
  if (table === "orders") return "phone_number"
  if (table === "shop_orders") return "customer_phone"
  return "recipient_phone" // api_orders / ussd_orders / ussd_shop_orders
}

function serviceClient() {
  return createClient(supabaseUrl, serviceRoleKey)
}

/**
 * Mark an order held (guarded: only from an in-flight status) and send the
 * one-time hold SMS. Best-effort SMS — never fails the hold.
 */
export async function holdMtnOrder(params: {
  table: MtnOrderTable
  orderId: string
  phone: string
}): Promise<{ held: boolean }> {
  const { table, orderId, phone } = params
  const supabase = serviceClient()
  const statusCol = statusColumnFor(table)

  const { data, error } = await supabase
    .from(table)
    .update({ [statusCol]: HOLD_STATUS, updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .in(statusCol, ["pending", "processing"]) // never clobber terminal states
    .select("id")

  if (error || !data || data.length === 0) {
    if (error) console.error(`[MTN-HOLD] hold update failed for ${table}/${orderId}:`, error)
    return { held: false }
  }

  console.log(`[MTN-HOLD] HELD ${table}/${orderId} (${phone})`)
  try {
    const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
    await sendSMS({
      phone,
      message: SMSTemplates.mtnRegistrationHold(phone),
      type: "mtn_registration_hold",
      reference: orderId,
    })
  } catch (smsErr) {
    console.warn(`[MTN-HOLD] hold SMS failed for ${orderId} (non-fatal):`, smsErr)
  }
  return { held: true }
}

/**
 * Release held orders whose beneficiary number is now 'registered'.
 * - phones (optional): normalized 0XXXXXXXXX hints from a just-registered
 *   batch; the registry is ALWAYS re-checked (hints are not trusted).
 * - Claims are guarded (held_registration -> pending) so a concurrent sweep
 *   skips rows another worker took.
 * - Dispatch reuses the existing fulfillment paths; a provider failure there
 *   follows the existing convention (order back to 'pending', admin-visible).
 *   Release NEVER re-holds. Deliberately ignores the gate toggle: draining
 *   holds must always work, even after the gate is switched off.
 */
export async function releaseHeldMtnOrders(
  phones?: string[]
): Promise<{ checked: number; released: number; dispatched: number; failed: number }> {
  const supabase = serviceClient()
  const { normalizeGhanaPhone } = await import("@/lib/phone-format")
  const hint = phones?.length
    ? new Set(phones.map(p => normalizeGhanaPhone(p) ?? p))
    : null

  let checked = 0, released = 0, dispatched = 0, failed = 0

  for (const table of MTN_ORDER_TABLES) {
    const statusCol = statusColumnFor(table)
    const phoneCol = phoneColumnFor(table)
    const extraCols = table === "ussd_orders" || table === "ussd_shop_orders"
      ? ", network, package_size" : ""

    const { data: heldRows, error } = await supabase
      .from(table)
      .select(`id, ${phoneCol}${extraCols}`)
      .eq(statusCol, HOLD_STATUS)
    if (error) {
      console.error(`[MTN-RELEASE] select failed for ${table}:`, error)
      continue
    }
    if (!heldRows?.length) continue

    // Normalize + optionally filter by the hint set.
    const candidates = (heldRows as any[])
      .map(r => ({ ...r, _norm: normalizeGhanaPhone(String(r[phoneCol] ?? "")) }))
      .filter(r => r._norm && (!hint || hint.has(r._norm)))
    if (!candidates.length) continue
    checked += candidates.length

    // Re-check the registry (source of truth).
    const uniquePhones = [...new Set(candidates.map(r => r._norm as string))]
    const { data: regRows, error: regErr } = await supabase
      .from("mtn_number_registry")
      .select("phone")
      .in("phone", uniquePhones)
      .eq("status", "registered")
    if (regErr) {
      console.error(`[MTN-RELEASE] registry check failed:`, regErr)
      continue
    }
    const registered = new Set((regRows ?? []).map(r => r.phone))

    for (const row of candidates) {
      if (!registered.has(row._norm)) continue

      // Atomic claim: held_registration -> pending.
      const { data: claimed, error: claimErr } = await supabase
        .from(table)
        .update({ [statusCol]: "pending", updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq(statusCol, HOLD_STATUS)
        .select("id")
      if (claimErr || !claimed || claimed.length === 0) continue
      released++

      try {
        if (table === "ussd_orders" || table === "ussd_shop_orders") {
          const { fulfillUssdOrder } = await import("@/lib/ussd/fulfill")
          const res = await fulfillUssdOrder(
            row.id, row.network ?? "MTN", row[phoneCol], row.package_size ?? "",
            false, table
          )
          res.success ? dispatched++ : failed++
        } else {
          const { processManualFulfillment } = await import("@/lib/fulfillment-service")
          const orderType = table === "orders" ? "bulk" : table === "api_orders" ? "api" : "shop"
          const res = await processManualFulfillment(row.id, orderType)
          res.success ? dispatched++ : failed++
        }
      } catch (dispatchErr) {
        console.error(`[MTN-RELEASE] dispatch threw for ${table}/${row.id}:`, dispatchErr)
        failed++
      }
    }
  }

  if (checked > 0) console.log(`[MTN-RELEASE] checked=${checked} released=${released} dispatched=${dispatched} failed=${failed}`)
  return { checked, released, dispatched, failed }
}
