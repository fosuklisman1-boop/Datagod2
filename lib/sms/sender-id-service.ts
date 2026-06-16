/**
 * Admin-managed Moolre sender IDs.
 *
 *   submitSenderId — register a sender ID with Moolre (type 3) and persist a row.
 *                    Integrators can't approve their own IDs, so the row starts
 *                    'pending' and is reconciled later by pollSenderIds.
 *   pollSenderIds  — query Moolre (type 1) for every still-pending row and update
 *                    its local_status. Driven by a cron.
 *
 * Service-role only; route-layer verifyAdminAccess is the boundary.
 */

import { createClient } from "@supabase/supabase-js"
import { createMoolreSenderId, queryMoolreSenderIdStatus } from "@/lib/sms-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface SmsSenderId {
  id: string
  sms_account_id: string | null
  sender_id: string
  moolre_status: string | null
  local_status: "pending" | "active" | "rejected"
  submitted_at: string
  last_polled_at: string | null
  created_at: string
  updated_at: string
}

type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * List sender IDs, newest first.
 *   accountId === undefined → ALL rows (admin SMS Centre view)
 *   accountId === <id>      → that tenant's own sender IDs only
 */
export async function listSenderIds(accountId?: string): Promise<ServiceResult<SmsSenderId[]>> {
  let query = supabaseAdmin.from("sms_sender_ids").select("*").order("created_at", { ascending: false })
  if (accountId !== undefined) query = query.eq("sms_account_id", accountId)

  const { data, error } = await query
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: (data ?? []) as SmsSenderId[] }
}

/**
 * Fetch a single sender-ID row by its (already-canonicalised) sender_id scoped to
 * an owner (a tenant account, or the admin-global NULL owner), or null. Scoping is
 * required: sender_id is only unique PER account, so an unscoped lookup could match
 * another tenant's row (and .maybeSingle would throw on >1).
 */
async function getBySenderId(senderId: string, accountId: string | null): Promise<SmsSenderId | null> {
  let query = supabaseAdmin.from("sms_sender_ids").select("*").eq("sender_id", senderId)
  query = accountId === null ? query.is("sms_account_id", null) : query.eq("sms_account_id", accountId)
  const { data } = await query.maybeSingle()
  return (data as SmsSenderId | null) ?? null
}

/**
 * Register a sender ID with Moolre and persist a pending row.
 * Idempotent per owner: if the owner already has this sender ID, returns the
 * existing row without re-submitting. Always normalises to upper-case.
 *
 * @param accountId  owning tenant account, or null for an admin/platform-global ID
 */
export async function submitSenderId(
  senderIdRaw: string,
  accountId: string | null = null
): Promise<ServiceResult<{ row: SmsSenderId; moolre: { ok: boolean; message?: string } }>> {
  // Canonicalise to upper-case (Moolre sender IDs are alnum) BEFORE the existence
  // check, the insert and the Moolre call — otherwise "DataGod" and "DATAGOD" are
  // treated as different IDs, defeating idempotency and per-owner uniqueness.
  const senderId = (senderIdRaw ?? "").trim().toUpperCase()
  if (senderId.length < 1 || senderId.length > 11)
    return { ok: false, error: "Sender ID must be 1–11 characters" }

  // Idempotency (per owner): return the existing row rather than colliding.
  const existing = await getBySenderId(senderId, accountId)
  if (existing) {
    return { ok: true, data: { row: existing, moolre: { ok: true, message: "Already submitted" } } }
  }

  const { data: row, error: insErr } = await supabaseAdmin
    .from("sms_sender_ids")
    .insert({ sender_id: senderId, local_status: "pending", sms_account_id: accountId })
    .select()
    .single()

  if (insErr) {
    // Lost a race to a concurrent submit (or a pre-existing row the lookup missed):
    // re-read and return it idempotently rather than surfacing a raw 23505.
    if ((insErr as { code?: string }).code === "23505") {
      const dup = await getBySenderId(senderId, accountId)
      if (dup) return { ok: true, data: { row: dup, moolre: { ok: true, message: "Already submitted" } } }
    }
    return { ok: false, error: insErr.message }
  }

  // Fire the Moolre registration. Failure here is non-fatal — the row stays pending
  // and the poll cron / a manual resubmit can reconcile it.
  const moolre = await createMoolreSenderId(senderId)

  const { data: updated } = await supabaseAdmin
    .from("sms_sender_ids")
    .update({ moolre_status: moolre.message ?? null, updated_at: new Date().toISOString() })
    .eq("id", (row as SmsSenderId).id)
    .select()
    .maybeSingle()

  return { ok: true, data: { row: (updated ?? row) as SmsSenderId, moolre } }
}

export interface PollSummary {
  polled: number
  updated: number
  results: { senderId: string; from: string; to: string }[]
}

/**
 * Query Moolre for every pending sender ID and update its local_status.
 * Returns a summary of which rows changed. Fail-soft per-row: one Moolre error
 * doesn't abort the rest.
 */
export async function pollSenderIds(): Promise<ServiceResult<PollSummary>> {
  const { data: pending, error } = await supabaseAdmin
    .from("sms_sender_ids")
    .select("id, sender_id, local_status")
    .eq("local_status", "pending")

  if (error) return { ok: false, error: error.message }

  const rows = (pending ?? []) as Pick<SmsSenderId, "id" | "sender_id" | "local_status">[]
  const summary: PollSummary = { polled: rows.length, updated: 0, results: [] }

  for (const r of rows) {
    const { rawStatus, localStatus } = await queryMoolreSenderIdStatus(r.sender_id)

    // queryMoolreSenderIdStatus fail-softs to these sentinels when it didn't get a
    // real Moolre status (network error / no API key / unrecognised). Don't let a
    // transient blip clobber the last-known-good moolre_status — just record that
    // we polled and move on.
    const isSentinel = rawStatus === "error" || rawStatus === "no_api_key" || rawStatus === "unknown"

    const patch: Record<string, unknown> = {
      last_polled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    if (!isSentinel) {
      patch.moolre_status = rawStatus
      patch.local_status = localStatus
    }

    const { error: updErr } = await supabaseAdmin.from("sms_sender_ids").update(patch).eq("id", r.id)
    if (updErr) continue

    if (!isSentinel && localStatus !== r.local_status) {
      summary.updated++
      summary.results.push({ senderId: r.sender_id, from: r.local_status, to: localStatus })
    }
  }

  return { ok: true, data: summary }
}
