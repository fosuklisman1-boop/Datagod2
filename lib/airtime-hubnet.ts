// Hubnet airtime provider. Customers have already paid: airtime is never sent twice
// and an order is never completed before Hubnet itself says so. charge.success only
// means "accepted" => the order is `processing`; a later status lookup completes it.
// Hubnet is its own attempt ledger (hubnetRef n = 1..5), checked BEFORE every placement.
// Logs and alerts carry the order reference / Hubnet ref / amount only, never the phone.

import type { SupabaseClient } from "@supabase/supabase-js"
import type { AirtimeOrderMinimal } from "@/lib/airtime-hubtel"
import { airtimeNetId } from "@/lib/airtime-provider"
import type { HubnetClient } from "@/lib/hubnet/client"
import {
  HUBNET_MAX_ATTEMPTS, classifyPlaceReply, hubnetRef, toHubnetPhone, type PlaceClass, type StatusLookup,
} from "@/lib/hubnet/core"
import { OUTCOME_UNKNOWN } from "@/lib/mtn-providers/outcome"
import { sendPushToUser } from "@/lib/push-service"
import { notifyAdmins } from "@/lib/sms-service"

export interface AirtimeHubnetDeps {
  client: HubnetClient
  /** When onlyFromStatuses is given the write MUST only apply to an order currently in one of those statuses. */
  markOrder(orderId: string, patch: { status?: string; notes: string }, onlyFromStatuses?: string[]): Promise<number | void>
  /** "review" = outcome unknown / needs a look, do not resend; "manual" (default) = not sent, fulfil manually. */
  alert(message: string, kind?: "manual" | "review"): Promise<void>
}

const quiet = async (p: Promise<unknown>, what: string) => {
  try { await p } catch (e: any) { console.error(`[AIRTIME-HUBNET] ${what} failed:`, e?.message ?? e) }
}

/**
 * Hand a paid airtime order to Hubnet. Returns true when Hubnet owns it now (processing, outcome unknown,
 * or an existing live attempt) and false when nothing was sent (manual needed).
 * Never resends, never falls back to another provider, never throws.
 */
export async function fulfillAirtimeViaHubnet(order: AirtimeOrderMinimal, deps: AirtimeHubnetDeps): Promise<boolean> {
  const tag = `${order.reference_code} (${order.network} GHS ${order.airtime_amount})`
  const notSent = async (why: string) => {
    await quiet(deps.markOrder(order.id, { notes: `Hubnet: not sent - ${why}. Fulfil manually.` }), "markOrder")
    await quiet(deps.alert(`Airtime ${tag} needs manual fulfilment: Hubnet not sent - ${why}`, "manual"), "alert")
    return false
  }
  /** Hubnet has (or may have) the order: record it as processing, guarded from pending. */
  const hold = async (note: string, ref: string) => {
    let rows: number | void = 0
    try {
      rows = await deps.markOrder(order.id, { status: "processing", notes: note }, ["pending"])
    } catch (e: any) {
      console.error("[AIRTIME-HUBNET] markOrder failed:", e?.message ?? e)
    }
    if (rows === 0) {
      // 0 rows = already moved on (e.g. a fast sync) or the write failed; a human must know Hubnet has it.
      await quiet(deps.alert(`Airtime ${tag}: Hubnet has this order (ref ${ref}) but it could not be marked processing - do not resend`, "review"), "alert")
    }
  }
  const review = (message: string) => quiet(deps.alert(message, "review"), "alert")
  const lookup = async (ref: string): Promise<StatusLookup> => {
    try { return await deps.client.getStatus(ref) } catch { return { kind: "unknown" } }
  }

  if (!airtimeNetId(order.network)) return notSent(`unsupported network "${order.network}"`)
  const phone = toHubnetPhone(order.beneficiary_phone)
  if (!phone) return notSent("invalid phone number")
  if (!(order.airtime_amount > 0)) return notSent("invalid amount")

  try {
    try { hubnetRef("airtime", order.id, 1) } catch { return await notSent("no order reference") }

    for (let n = 1; n <= HUBNET_MAX_ATTEMPTS; n++) {
      const ref = hubnetRef("airtime", order.id, n)
      const lk = await lookup(ref)
      if (lk.kind === "unknown") {
        await hold(`Hubnet: outcome unknown [hubnetRef:${ref}]. Do not resend.`, ref)
        await review(`Airtime ${tag}: Hubnet status unknown (ref ${ref}) - check Hubnet, do not resend`)
        return true
      }
      if (lk.kind === "found") {
        if (!lk.refunded && lk.status !== "failed") {
          await hold(`Hubnet: existing attempt resumed [hubnetRef:${ref}]`, ref)
          return true
        }
        continue // failed or refunded: next attempt
      }
      return await place(ref)
    }
    return await notSent(`all ${HUBNET_MAX_ATTEMPTS} attempts used`)

    async function place(ref: string): Promise<boolean> {
      let cls: PlaceClass
      try {
        const r = await deps.client.placeAirtime({ phone: phone as string, amountGhs: order.airtime_amount, reference: ref })
        if (!r.ok) {
          if (r.response.error_type !== OUTCOME_UNKNOWN) return await notSent("Hubnet request failed before it was sent")
          cls = "unknown"
        } else {
          cls = classifyPlaceReply(r.res.status, r.json)
        }
      } catch {
        cls = "unknown"
      }

      if (cls === "success") {
        await hold(`Sent via Hubnet [hubnetRef:${ref}]`, ref)
        return true
      }
      if (cls === "duplicate" || cls === "unknown") {
        const lk = await lookup(ref)
        if (lk.kind === "found" && lk.status !== "failed" && !lk.refunded) {
          await hold(`Sent via Hubnet (reconciled) [hubnetRef:${ref}]`, ref)
          return true
        }
        await hold(`Hubnet: outcome unknown [hubnetRef:${ref}]. Do not resend.`, ref)
        await review(`Airtime ${tag}: Hubnet outcome unknown (ref ${ref}) - check Hubnet, do not resend`)
        return true
      }
      if (cls === "insufficient_balance") return notSent("Hubnet balance too low")
      if (cls === "auth") return notSent("Hubnet authentication failed")
      if (cls === "rate_limited") return notSent("Hubnet rate limited")
      return notSent("Hubnet rejected the order")
    }
  } catch (e: any) {
    // Never throws. Whatever got us here may have happened after a placement: hold for a human, do not resend.
    console.error(`[AIRTIME-HUBNET] unexpected error for ${order.reference_code}:`, e?.message ?? e)
    await review(`Airtime ${tag}: unexpected error during Hubnet fulfilment - check Hubnet before doing anything, do not resend`)
    return true
  }
}

type AlertFn = (message: string, kind?: "manual" | "review") => Promise<void>

/**
 * Apply a Hubnet status lookup to a `processing` airtime order. Guarded on status=processing so a
 * concurrent writer wins. Returns true only when a row moved.
 */
export async function applyHubnetAirtimeStatus(
  db: SupabaseClient,
  orderId: string,
  lookup: StatusLookup,
  alert?: AlertFn,
): Promise<boolean> {
  if (lookup.kind !== "found") return false
  const failed = lookup.status === "failed" || lookup.refunded
  const completed = lookup.status === "completed" && !lookup.refunded
  if (!failed && !completed) return false

  const { data: cur, error: readErr } = await db
    .from("airtime_orders")
    .select("id, reference_code, network, airtime_amount, user_id, notes, status")
    .eq("id", orderId)
    .maybeSingle()
  if (readErr || !cur || cur.status !== "processing") return false

  const now = new Date().toISOString()
  const patch = completed
    ? { status: "completed", notes: `${cur.notes ?? ""} Completed via Hubnet`.trim(), updated_at: now }
    : { status: "pending", notes: `${cur.notes ?? ""} Hubnet failed`.trim(), updated_at: now }
  const { data: moved, error } = await db
    .from("airtime_orders")
    .update(patch)
    .eq("id", orderId)
    .eq("status", "processing")
    .select("id")
  if (error) throw error
  if (!moved || moved.length === 0) return false

  if (completed) {
    if (cur.user_id) {
      const title = "Airtime Delivered Successfully"
      const body = `Your ₵${cur.airtime_amount} ${cur.network} airtime order ${cur.reference_code} has been delivered.`
      try {
        const { error: nErr } = await db.from("notifications").insert({
          user_id: cur.user_id, title, message: body, type: "order_completed",
          reference_id: orderId, action_url: "/dashboard/airtime", read: false,
        })
        if (nErr) console.error(`[AIRTIME-HUBNET] notification failed for ${cur.reference_code}:`, nErr.message ?? nErr)
      } catch (e: any) {
        console.error(`[AIRTIME-HUBNET] notification threw for ${cur.reference_code}:`, e?.message ?? e)
      }
      Promise.resolve(sendPushToUser(cur.user_id, { title, body, data: { url: "/dashboard/airtime" } })).catch(() => {})
    }
  } else {
    const send: AlertFn = alert ?? (async (message, kind) => {
      await notifyAdmins(message, kind === "review" ? "airtime_hubnet_review" : "airtime_manual_needed", orderId, true)
    })
    await quiet(send(`Airtime ${cur.reference_code} (${cur.network} GHS ${cur.airtime_amount}): Hubnet failed or refunded it. The order is back to pending - fulfil manually or retry`, "manual"), "alert")
  }
  return true
}

const REF_RE = /\[hubnetRef:(D[GA][0-9a-f]{22}(?:R[2-5])?)\]/g

function lastHubnetRef(notes: string | null | undefined): string | null {
  let last: string | null = null
  for (const m of (notes ?? "").matchAll(REF_RE)) last = m[1]
  return last
}

/** Re-check `processing` airtime orders that carry a Hubnet reference and apply the result. */
export async function syncHubnetAirtime(
  db: SupabaseClient,
  client: HubnetClient,
  limit = 50,
): Promise<{ checked: number; updated: number }> {
  const { data, error } = await db
    .from("airtime_orders")
    .select("id, reference_code, notes")
    .eq("status", "processing")
    .like("notes", "%[hubnetRef:%")
    .order("updated_at", { ascending: true })
    .limit(limit)
  if (error) throw error
  let checked = 0
  let updated = 0
  for (const row of data ?? []) {
    const ref = lastHubnetRef(row.notes)
    if (!ref) continue
    checked++
    try {
      const lk = await client.getStatus(ref)
      if (await applyHubnetAirtimeStatus(db, row.id, lk)) updated++
    } catch (e: any) {
      console.error(`[AIRTIME-HUBNET] sync failed for ${row.reference_code}:`, e?.message ?? e)
    }
  }
  return { checked, updated }
}
