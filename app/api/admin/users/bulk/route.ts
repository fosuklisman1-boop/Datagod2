import { NextRequest, NextResponse } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { gateAdmin, serviceClient, writeAudit } from "@/lib/admin-users/route-utils"
import { NOTIFY_MATCHING_MAX, parseBulkRequest, type BulkRequest } from "@/lib/admin-users/bulk-params"
import { changeUserRole, setUserSuspended } from "@/lib/admin-users/account-ops"
import { sendBulkNotification, type BulkUserResult, type NotifyRecipient } from "@/lib/admin-users/bulk-notify"
import { parseExportRpcResult, toExportRpcArgs, type ExportCursor } from "@/lib/admin-users/export-params"
import type { UsersListFilters } from "@/lib/admin-users/list-params"
import { runAfterResponse } from "@/lib/admin-users/after-response"

export const dynamic = "force-dynamic"
// The request itself only does database work (about 4 queries per user, 5 users at a time: ~20s for 200).
// Suspension SMS / email go out after the response (runAfterResponse), 5 at a time, inside the same 300s.
export const maxDuration = 300

/** Users processed at once for role and suspension changes. */
const CONCURRENCY = 5
/** Rows per admin_export_users call when resolving "every matching user". */
const MATCHING_CHUNK = 1000
/** Rows per audit insert for notify. */
const AUDIT_CHUNK = 100

/**
 * POST /api/admin/users/bulk { action, userIds | matching, params }   (lib/admin-users/bulk-params.ts)
 *
 *   set_role   params.role user | dealer | admin    each user through changeUserRole (the update-role rules)
 *   suspend    params.reason (required)             each user through setUserSuspended (the suspend route's work)
 *   unsuspend  params.reason (optional)
 *   notify     params.title, message, channels      in-app rows + the Broadcast page's push / SMS path
 *
 * Only a signed-in admin (the CRON bypass is refused: every change is audited under the acting admin). At most
 * 200 explicit userIds. `matching` (every user matching the list filters, resolved here) only for notify, up to
 * the broadcast limit of 5000. The acting admin is skipped, with an error, for role and suspension changes.
 * Role / suspension changes write one admin_audit_log row per user changed (in the shared helpers); users already
 * in the requested state are reported ok with "unchanged" and get no row. notify writes one 'user_notify' row per
 * user notified.
 *
 * 200: { action, total, succeeded, failed, results: [{ id, ok, error?, note? }], broadcastId? }
 */
export async function POST(req: NextRequest) {
  const gate = await gateAdmin(req, { write: true })
  if (!gate.ok) return gate.response
  const adminId = gate.adminId!

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 })
  }
  const parsed = parseBulkRequest(body)
  if (!parsed.ok) return NextResponse.json({ error: "Invalid request", details: parsed.errors }, { status: 400 })
  const request = parsed.request

  try {
    const db = serviceClient()
    if (request.action === "notify") return await notify(db, adminId, request)

    // Suspension notices are sent after the response so 200 users finish well inside maxDuration.
    const deferred: Array<() => Promise<void>> = []
    const results = await mapLimit(request.target.ids, CONCURRENCY, async (id): Promise<BulkUserResult> => {
      if (id === adminId.toLowerCase()) {
        return { id, ok: false, error: request.action === "set_role" ? "You cannot change your own role" : "You cannot suspend or unsuspend yourself" }
      }
      try {
        const r = request.action === "set_role"
          ? await changeUserRole(db, { userId: id, role: request.role, adminId })
          : await setUserSuspended(db, {
              userId: id, suspend: request.action === "suspend", reason: request.reason, adminId, skipUnchanged: true,
              deferNotifications: (send) => { deferred.push(send) },
            })
        if (!r.ok) return { id, ok: false, error: r.error }
        const notes = [
          !r.changed && "unchanged",
          "note" in r && r.note,
          r.changed && !r.audited && "audit log entry could not be written",
        ].filter(Boolean)
        return notes.length ? { id, ok: true, note: notes.join("; ") } : { id, ok: true }
      } catch (e: any) {
        console.error(`[ADMIN-BULK] ${request.action} ${id} failed:`, e?.message ?? e)
        return { id, ok: false, error: "Unexpected error" }
      }
    })
    if (deferred.length) runAfterResponse(async () => { await mapLimit(deferred, CONCURRENCY, (send) => send()) })
    return NextResponse.json(summary(request.action, results))
  } catch (e: any) {
    console.error("[ADMIN-BULK] error:", e?.message ?? e)
    return NextResponse.json({ error: "Bulk action failed" }, { status: 500 })
  }
}

async function notify(db: SupabaseClient, adminId: string, request: Extract<BulkRequest, { action: "notify" }>) {
  let recipients: NotifyRecipient[]
  const missing: BulkUserResult[] = []
  if (request.target.kind === "ids") {
    const ids = request.target.ids
    const { data, error } = await db.from("users").select("id, email, phone_number, first_name").in("id", ids)
    if (error) {
      console.error("[ADMIN-BULK] notify recipients:", error.message)
      return NextResponse.json({ error: "Failed to load the selected users" }, { status: 500 })
    }
    const byId = new Map((data ?? []).map((u: any) => [u.id as string, u]))
    recipients = []
    for (const id of ids) {
      const u = byId.get(id)
      if (!u) missing.push({ id, ok: false, error: "User not found" })
      else recipients.push({ id, email: u.email ?? null, phone: u.phone_number ?? null, name: u.first_name ?? null })
    }
  } else {
    const resolved = await resolveMatching(db, request.target.filters)
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status })
    recipients = resolved.recipients
    if (recipients.length === 0) return NextResponse.json({ error: "No users match these filters" }, { status: 400 })
  }

  const sent = recipients.length
    ? await sendBulkNotification(db, { adminId, recipients, title: request.title, message: request.message, channels: request.channels })
    : { results: [], delivered: new Map<string, string[]>(), broadcastId: null, broadcastError: null }

  // One audit row per user notified, listing the channels that actually went out for them (or were queued), in
  // batches. A failed batch is reported and the next one still written.
  const notified = sent.results.filter((r) => r.ok).map((r) => r.id)
  let auditFailed = 0
  for (let i = 0; i < notified.length; i += AUDIT_CHUNK) {
    const batch = notified.slice(i, i + AUDIT_CHUNK)
    const ok = await writeAuditBatch(db, batch.map((id) => {
      const channels = sent.delivered.get(id) ?? []
      return {
        admin_id: adminId, action: "user_notify", target_user_id: id,
        new_value: { title: request.title, channels, broadcast_id: channels.some((c) => c !== "in_app") ? sent.broadcastId : null },
      }
    }))
    if (!ok) auditFailed += batch.length
  }

  return NextResponse.json({ ...summary("notify", [...sent.results, ...missing]), broadcastId: sent.broadcastId, auditFailed })
}

/** Every user matching the list filters, through admin_export_users (the export's keyset paging), up to the limit. */
async function resolveMatching(db: SupabaseClient, filters: UsersListFilters):
  Promise<{ ok: true; recipients: NotifyRecipient[] } | { ok: false; status: number; error: string }> {
  const recipients: NotifyRecipient[] = []
  let cursor: ExportCursor | null = null
  for (;;) {
    const { data, error } = await db.rpc("admin_export_users", toExportRpcArgs(filters, cursor, MATCHING_CHUNK))
    if (error) {
      console.error("[ADMIN-BULK] admin_export_users:", error.message)
      return { ok: false, status: 500, error: "Failed to resolve the matching users" }
    }
    const page = parseExportRpcResult(data)
    for (const r of page.rows as any[]) {
      recipients.push({ id: r.id, email: r.email ?? null, phone: r.phone_number ?? null, name: r.first_name ?? null })
    }
    if (recipients.length > NOTIFY_MATCHING_MAX) {
      return {
        ok: false,
        status: 400,
        error: `More than ${NOTIFY_MATCHING_MAX.toLocaleString()} users match these filters. Narrow them, or use the Broadcast page.`,
      }
    }
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  return { ok: true, recipients }
}

async function writeAuditBatch(db: SupabaseClient, rows: Array<Parameters<typeof writeAudit>[1]>): Promise<boolean> {
  const { error } = await db.from("admin_audit_log").insert(rows.map((r) => ({ ...r, old_value: r.old_value ?? null, new_value: r.new_value ?? null })))
  if (error) console.error("[ADMIN-AUDIT] user_notify insert failed:", error.message)
  return !error
}

function summary(action: string, results: BulkUserResult[]) {
  const succeeded = results.filter((r) => r.ok).length
  return { action, total: results.length, succeeded, failed: results.length - succeeded, results }
}

/** Map with at most `limit` calls in flight; results in input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}
