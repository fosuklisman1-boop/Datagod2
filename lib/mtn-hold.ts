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
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

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
 * Pure gate decision. Hold iff the gate is enabled AND the registry says the
 * number is awaiting registration (pending/submitted, or missing entirely).
 * 'registered' passes (fulfillable). 'rejected' ALSO passes — a rejected
 * number (non-MTN prefix / provider-rejected) can never be activated, so
 * holding would strand the order forever; instead it fails fast at the
 * provider and lands in the manual queue, exactly as before the gate existed.
 */
export function decideMtnGate(
  gateEnabled: boolean,
  registryStatus: string | null
): { hold: boolean } {
  if (!gateEnabled) return { hold: false }
  return { hold: registryStatus !== "registered" && registryStatus !== "rejected" }
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

export const STRICT_HOLDS_TABLE = "mtn_strict_holds"
export type StrictHoldReason = "rejected" | "unanswered"

/** The relation is not there yet (0194 not applied): Postgres undefined_table or PostgREST's schema-cache miss. */
function isMissingTable(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205"
}

/**
 * Does this order have an OPEN strict hold (strict supplier verification)?
 * The registry/whitelist releasers must leave those to the strict re-check.
 * Read error = true (never release what cannot be classified); a missing
 * table = false (no strict hold can exist before 0194 is applied).
 */
export async function isStrictHeld(db: SupabaseClient, table: MtnOrderTable, orderId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from(STRICT_HOLDS_TABLE)
      .select("order_id")
      .eq("order_table", table)
      .eq("order_id", orderId)
      .eq("state", "open")
      .maybeSingle()
    if (error) return !isMissingTable(error)
    return !!data
  } catch {
    return true
  }
}

/**
 * Record (or re-open) the strict hold row and send the one strict-hold SMS
 * the order ever gets. Returns false when the hold row could not be written.
 */
async function recordStrictHold(
  supabase: SupabaseClient,
  table: MtnOrderTable,
  orderId: string,
  phone: string,
  reason: StrictHoldReason
): Promise<boolean> {
  const { normalizeGhanaPhone } = await import("@/lib/phone-format")
  const storedPhone = normalizeGhanaPhone(phone) ?? phone
  const now = new Date().toISOString()

  const { data: existing, error: readErr } = await supabase
    .from(STRICT_HOLDS_TABLE)
    .select("state")
    .eq("order_table", table)
    .eq("order_id", orderId)
    .maybeSingle()
  if (readErr) {
    console.error(`[MTN-HOLD] strict hold read failed for ${table}/${orderId}:`, readErr.code ?? "error")
    return false
  }

  let writeErr: { code?: string } | null = null
  if (!existing) {
    const { error } = await supabase.from(STRICT_HOLDS_TABLE).insert({
      order_table: table, order_id: orderId, phone: storedPhone, reason,
      state: "open", held_at: now, last_checked_at: null, sms_sent: false, closed_at: null,
    })
    writeErr = error
    if (error?.code === "23505") {
      // Created between the read and the insert: re-open it (an open row keeps its held_at).
      const { error: upErr } = await supabase.from(STRICT_HOLDS_TABLE)
        .update({ reason, phone: storedPhone, state: "open", closed_at: null })
        .eq("order_table", table).eq("order_id", orderId)
      writeErr = upErr
    }
  } else if ((existing as { state?: string }).state === "open") {
    // Still open: keep held_at (the 72 h limit runs from the first hold) and sms_sent.
    const { error } = await supabase.from(STRICT_HOLDS_TABLE)
      .update({ reason, phone: storedPhone })
      .eq("order_table", table).eq("order_id", orderId)
    writeErr = error
  } else {
    // Released/expired earlier and held again: a new hold episode. sms_sent is kept (one SMS per order).
    const { error } = await supabase.from(STRICT_HOLDS_TABLE)
      .update({ reason, phone: storedPhone, state: "open", held_at: now, last_checked_at: null, closed_at: null })
      .eq("order_table", table).eq("order_id", orderId)
    writeErr = error
  }
  if (writeErr) {
    console.error(`[MTN-HOLD] strict hold write failed for ${table}/${orderId}:`, writeErr.code ?? "error")
    return false
  }

  // Claim the one SMS atomically (sms_sent false -> true), then send. Best-effort.
  const { data: claimed, error: claimErr } = await supabase.from(STRICT_HOLDS_TABLE)
    .update({ sms_sent: true })
    .eq("order_table", table).eq("order_id", orderId).eq("sms_sent", false)
    .select("order_id")
  if (claimErr || !claimed || claimed.length === 0) return true
  try {
    const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
    await sendSMS({
      phone,
      message: SMSTemplates.mtnStrictHold(phone),
      type: "mtn_strict_hold",
      reference: orderId,
    })
  } catch {
    console.warn(`[MTN-HOLD] strict hold SMS failed for ${orderId} (non-fatal)`)
  }
  return true
}

/**
 * Mark an order held (guarded: only from an in-flight status) and send the
 * one-time hold SMS. Best-effort SMS — never fails the hold.
 *
 * errorType "STRICT_HOLD" (strict supplier verification): also records an
 * open mtn_strict_holds row with the reason and sends the strict-hold SMS
 * once per order (re-holds send nothing). If that row cannot be written the
 * order is put back to pending (never stranded in an untracked hold).
 * Any other errorType: unchanged (registration SMS on every hold).
 */
export async function holdMtnOrder(params: {
  table: MtnOrderTable
  orderId: string
  phone: string
  errorType?: string
  strictReason?: StrictHoldReason
}): Promise<{ held: boolean }> {
  const { table, orderId, phone, errorType, strictReason } = params
  const supabase = serviceClient()
  const statusCol = statusColumnFor(table)

  const { data, error } = await supabase
    .from(table)
    .update({ [statusCol]: HOLD_STATUS, updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .in(statusCol, ["pending", "processing", "failed"]) // failed = re-dispatchable (admin reprocess); never clobber completed/cancelled
    .select("id")

  if (error || !data || data.length === 0) {
    if (error) console.error(`[MTN-HOLD] hold update failed for ${table}/${orderId}:`, error)
    return { held: false }
  }

  if (errorType === "STRICT_HOLD") {
    const reason: StrictHoldReason = strictReason === "rejected" ? "rejected" : "unanswered"
    const recorded = await recordStrictHold(supabase, table, orderId, phone, reason)
    if (!recorded) {
      await supabase
        .from(table)
        .update({ [statusCol]: "pending", updated_at: new Date().toISOString() })
        .eq("id", orderId)
        .eq(statusCol, HOLD_STATUS)
      console.error(`[MTN-HOLD] strict hold not recorded for ${table}/${orderId}: order back to pending`)
      return { held: false }
    }
    console.log(`[MTN-HOLD] STRICT HELD ${table}/${orderId} (${reason})`)
    return { held: true }
  }

  console.log(`[MTN-HOLD] HELD ${table}/${orderId}`)
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
): Promise<{ checked: number; released: number; dispatched: number; queuedManual: number; failed: number }> {
  const supabase = serviceClient()
  const { normalizeGhanaPhone } = await import("@/lib/phone-format")
  const hint = phones?.length
    ? new Set(phones.map(p => normalizeGhanaPhone(p) ?? p))
    : null

  let checked = 0, released = 0, dispatched = 0, queuedManual = 0, failed = 0

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
      // A strict hold waits for its supplier approval (strict re-check job), never the registry.
      if (await isStrictHeld(supabase, table, row.id)) continue

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
          if (res.success && res.message.toLowerCase().includes("manual")) queuedManual++
          else if (res.success) dispatched++
          else failed++
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

  if (checked > 0) console.log(`[MTN-RELEASE] checked=${checked} released=${released} dispatched=${dispatched} queuedManual=${queuedManual} failed=${failed}`)
  return { checked, released, dispatched, queuedManual, failed }
}

/**
 * Release held_registration orders for numbers now approved by the provider
 * whitelist. Unlike releaseHeldMtnOrders this does NOT re-check mtn_number_registry
 * status — approval came from the provider API itself.
 */
export async function releaseWhitelistHeldOrders(
  phones: string[]
): Promise<{ released: number; dispatched: number; failed: number }> {
  const supabase = serviceClient()
  const { normalizeGhanaPhone } = await import("@/lib/phone-format")
  const phoneSet = new Set(phones.map(p => normalizeGhanaPhone(p) ?? p))

  let released = 0, dispatched = 0, failed = 0

  for (const table of MTN_ORDER_TABLES) {
    const statusCol = statusColumnFor(table)
    const phoneCol = phoneColumnFor(table)
    const isUssd = table === "ussd_orders" || table === "ussd_shop_orders"
    const extraCols = isUssd ? ", network, package_size" : ""

    const { data: rows } = await supabase
      .from(table)
      .select(`id, ${phoneCol}${extraCols}`)
      .eq(statusCol, HOLD_STATUS)
      .in(phoneCol, [...phoneSet])

    for (const row of (rows ?? []) as any[]) {
      // A strict hold waits for its supplier approval (strict re-check job), never this releaser.
      if (await isStrictHeld(supabase, table, row.id)) continue
      const { data: claimed } = await supabase
        .from(table)
        .update({ [statusCol]: "pending", updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq(statusCol, HOLD_STATUS)
        .select("id")

      if (!claimed || claimed.length === 0) continue
      released++

      try {
        if (isUssd) {
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
      } catch (err) {
        console.error(`[MTN-WL-RELEASE] dispatch failed for ${table}/${row.id}:`, err)
        failed++
      }
    }
  }

  console.log(`[MTN-WL-RELEASE] released=${released} dispatched=${dispatched} failed=${failed}`)
  return { released, dispatched, failed }
}

/**
 * Read-only: normalized, deduped phones currently on a held_registration
 * order, across all 5 order tables. Used by the on-demand "release held
 * orders now" admin action to find phones worth re-checking against
 * whitelist_status — releaseHeldMtnOrders() already does its own
 * registration-status re-check internally and needs no phone list, but
 * releaseWhitelistHeldOrders() requires an explicit list of phones to check.
 */
export async function getHeldOrderPhones(): Promise<string[]> {
  const supabase = serviceClient()
  const { normalizeGhanaPhone } = await import("@/lib/phone-format")
  const phones = new Set<string>()

  for (const table of MTN_ORDER_TABLES) {
    const statusCol = statusColumnFor(table)
    const phoneCol = phoneColumnFor(table)
    const { data, error } = await supabase
      .from(table)
      .select(`id, ${phoneCol}`)
      .eq(statusCol, HOLD_STATUS)
    if (error) {
      console.error(`[MTN-HOLD] getHeldOrderPhones select failed for ${table}:`, error)
      continue
    }
    for (const row of (data as any[]) ?? []) {
      // Strict holds are re-checked by the strict job, not by the whitelist releaser this list feeds.
      if (await isStrictHeld(supabase, table, String((row as any).id))) continue
      const norm = normalizeGhanaPhone(String((row as any)[phoneCol] ?? ""))
      if (norm) phones.add(norm)
    }
  }

  return [...phones]
}
