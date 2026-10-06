// lib/ussd-hubtel/resolve.ts
// Admin "mark resolved" for needs_review Hubtel rows. Conservative by design: only needs_review
// rows; only while the row is still in the exact shape the admin saw; "not paid" only for rows
// with no recorded payment and no callback due; never invents a Hubtel OrderId.
import type { SupabaseClient } from "@supabase/supabase-js"
import type { OrderHandlers } from "./payment"
import type { HubtelCallbackStatus, HubtelTxRow } from "./types"
import { safeDbError } from "./log-safe"

export type ResolveOutcome = "fulfilled" | "not_paid"

export type ResolveResult =
  | { ok: true; state: "fulfilled" | "failed"; callbackStatus: HubtelCallbackStatus; callbackNote: string }
  | { ok: false; status: 400 | 404 | 409; error: string }

export const RESOLUTION_NOTE_MIN = 5
export const RESOLUTION_NOTE_MAX = 500

export async function resolveNeedsReview(args: {
  supabase: SupabaseClient
  failHandlers: OrderHandlers
  sessionId: string
  outcome: ResolveOutcome
  note: string
  adminId: string
  now?: Date
}): Promise<ResolveResult> {
  const note = (args.note ?? "").trim()
  if (note.length < RESOLUTION_NOTE_MIN || note.length > RESOLUTION_NOTE_MAX) {
    return { ok: false, status: 400, error: `A note of ${RESOLUTION_NOTE_MIN}-${RESOLUTION_NOTE_MAX} characters is required.` }
  }
  if (args.outcome !== "fulfilled" && args.outcome !== "not_paid") {
    return { ok: false, status: 400, error: "Unknown outcome." }
  }

  const { data, error } = await args.supabase.from("hubtel_transactions").select("*").eq("session_id", args.sessionId).maybeSingle()
  if (error) throw error
  if (!data) return { ok: false, status: 404, error: "Transaction not found." }
  const row = data as HubtelTxRow
  if (row.state !== "needs_review") {
    return { ok: false, status: 409, error: `Only needs_review rows can be resolved (this one is ${row.state}).` }
  }
  const noPaymentRecorded = row.paid_at == null && row.callback_status === "not_due"
  if (args.outcome === "not_paid" && !noPaymentRecorded) {
    return { ok: false, status: 409, error: "This row has a recorded payment or a due callback, so it cannot be resolved as not paid." }
  }

  const nowIso = (args.now ?? new Date()).toISOString()
  const state: "fulfilled" | "failed" = args.outcome === "not_paid" ? "failed" : "fulfilled"
  const patch: Record<string, unknown> = {
    state, resolution_note: note, resolved_by: args.adminId, resolved_at: nowIso, updated_at: nowIso,
  }
  let callbackStatus: HubtelCallbackStatus = row.callback_status
  let callbackNote: string
  if (args.outcome === "not_paid") {
    callbackNote = "No callback: the customer did not pay."
  } else if (row.callback_status === "not_due" && row.hubtel_order_id) {
    callbackStatus = "pending"
    patch.callback_status = "pending"
    patch.paid_at = row.paid_at ?? nowIso // the callbacks cron bounds its 55-minute window by paid_at
    callbackNote = "Success callback queued."
  } else if (row.callback_status === "not_due") {
    callbackNote = "No Hubtel order id on record, so no callback can be sent."
  } else {
    callbackNote = `Callback left as ${row.callback_status}.`
  }

  // Win only if the row is still exactly what was read: a late webhook or a second admin changes it.
  let q = args.supabase
    .from("hubtel_transactions")
    .update(patch)
    .eq("session_id", args.sessionId)
    .eq("state", "needs_review")
    .eq("callback_status", row.callback_status)
  if (row.paid_at == null) q = q.is("paid_at", null)
  const { data: updated, error: updErr } = await q.select("session_id")
  if (updErr) throw updErr
  if (!updated || updated.length === 0) {
    return { ok: false, status: 409, error: "The row changed while you were resolving it. Reload and try again." }
  }

  if (args.outcome === "not_paid") {
    try {
      const fail = args.failHandlers[row.order_table]
      if (fail) await fail(row.order_id)
    } catch (e) { console.error("[HUBTEL-RESOLVE] fail handler error:", args.sessionId, safeDbError(e)) }
  }

  const { error: auditErr } = await args.supabase.from("admin_audit_log").insert([{
    admin_id: args.adminId,
    action: "hubtel_resolve_needs_review",
    target_user_id: null,
    old_value: {
      session_id: row.session_id, order_table: row.order_table, order_id: row.order_id,
      state: row.state, callback_status: row.callback_status, callback_last_error: row.callback_last_error,
    },
    new_value: { outcome: args.outcome, state, callback_status: callbackStatus, note },
    created_at: nowIso,
  }])
  if (auditErr) console.warn("[ADMIN-AUDIT] hubtel_resolve_needs_review log insert failed:", safeDbError(auditErr))

  return { ok: true, state, callbackStatus, callbackNote }
}
