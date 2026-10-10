/**
 * Admin-managed sender IDs, dual-provider (Moolre + mNotify).
 *
 *   submitSenderId   — persist a pending row. Does NOT contact any provider;
 *                       pushing is a separate, explicit admin action.
 *   pushSenderId     — admin-triggered register call to one provider.
 *   fetchSenderIdStatus — admin-triggered on-demand status check against one provider.
 *   pollSenderIds    — query every pushed-but-still-pending row on both providers
 *                       and update its local_status. Driven by a cron.
 *   rejectSenderId   — admin-only, provider-call-free local 'rejected' override.
 *   approveSenderId  — admin-only, provider-call-free local 'active' override
 *                       (for when a provider's status API can't be trusted).
 *
 * Service-role only; route-layer verifyAdminAccess is the boundary.
 */

import { createClient } from "@supabase/supabase-js"
import { createMoolreSenderId, queryMoolreSenderIdStatus } from "@/lib/sms-service"
import { createMnotifySenderId, queryMnotifySenderIdStatus } from "@/lib/mnotify-sender-id"

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
  moolre_pushed_at: string | null
  mnotify_status: string | null
  mnotify_local_status: "pending" | "active" | "rejected"
  mnotify_pushed_at: string | null
  mnotify_last_polled_at: string | null
  submitted_at: string
  last_polled_at: string | null
  created_at: string
  updated_at: string
}

export type SenderIdProvider = "moolre" | "mnotify"

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
 * Persist a pending sender-ID row. Does NOT contact Moolre or mNotify —
 * pushing to a provider is now a separate, explicit admin action
 * (pushSenderId) so an admin can choose which provider(s) to push to.
 * Idempotent per owner: if the owner already has this sender ID, returns the
 * existing row without re-inserting. Always normalises to upper-case.
 *
 * @param accountId  owning tenant account, or null for an admin/platform-global ID
 */
export async function submitSenderId(
  senderIdRaw: string,
  accountId: string | null = null
): Promise<ServiceResult<{ row: SmsSenderId }>> {
  // Canonicalise to upper-case (sender IDs are alnum) BEFORE the existence
  // check and the insert — otherwise "DataGod" and "DATAGOD" are treated as
  // different IDs, defeating idempotency and per-owner uniqueness.
  const senderId = (senderIdRaw ?? "").trim().toUpperCase()
  if (senderId.length < 1 || senderId.length > 11)
    return { ok: false, error: "Sender ID must be 1–11 characters" }

  // Idempotency (per owner): return the existing row rather than colliding.
  const existing = await getBySenderId(senderId, accountId)
  if (existing) {
    return { ok: true, data: { row: existing } }
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
      if (dup) return { ok: true, data: { row: dup } }
    }
    return { ok: false, error: insErr.message }
  }

  return { ok: true, data: { row: row as SmsSenderId } }
}

export async function getById(id: string): Promise<SmsSenderId | null> {
  const { data } = await supabaseAdmin.from("sms_sender_ids").select("*").eq("id", id).maybeSingle()
  return (data as SmsSenderId | null) ?? null
}

/**
 * Admin-triggered push to a specific provider. Fires the provider's register
 * call and stamps that provider's pushed_at so pollSenderIds knows to poll it.
 */
export async function pushSenderId(
  id: string,
  provider: SenderIdProvider
): Promise<ServiceResult<{ row: SmsSenderId; result: { ok: boolean; message?: string } }>> {
  const row = await getById(id)
  if (!row) return { ok: false, error: "Sender ID not found" }

  const result =
    provider === "moolre" ? await createMoolreSenderId(row.sender_id) : await createMnotifySenderId(row.sender_id)

  const patch: Record<string, unknown> =
    provider === "moolre"
      ? { moolre_status: result.message ?? null, moolre_pushed_at: new Date().toISOString() }
      : { mnotify_status: result.message ?? null, mnotify_pushed_at: new Date().toISOString() }
  patch.updated_at = new Date().toISOString()

  const { data: updated, error } = await supabaseAdmin
    .from("sms_sender_ids")
    .update(patch)
    .eq("id", id)
    .select()
    .maybeSingle()

  if (error || !updated) return { ok: false, error: error?.message ?? "Sender ID not found" }
  return { ok: true, data: { row: updated as SmsSenderId, result } }
}

/**
 * Admin-triggered immediate status check against one provider (same query
 * pollSenderIds runs in bulk, but on demand for a single row).
 */
export async function fetchSenderIdStatus(
  id: string,
  provider: SenderIdProvider
): Promise<ServiceResult<SmsSenderId>> {
  const row = await getById(id)
  if (!row) return { ok: false, error: "Sender ID not found" }

  const { rawStatus, localStatus } =
    provider === "moolre"
      ? await queryMoolreSenderIdStatus(row.sender_id)
      : await queryMnotifySenderIdStatus(row.sender_id)

  const isSentinel = rawStatus === "error" || rawStatus === "no_api_key" || rawStatus === "unknown"
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (provider === "moolre") {
    patch.last_polled_at = new Date().toISOString()
    if (!isSentinel) {
      patch.moolre_status = rawStatus
      // Tenant sender approval is ours (sender-rules-service); a provider status must never activate it.
      if (row.sms_account_id == null) patch.local_status = localStatus
    }
  } else {
    patch.mnotify_last_polled_at = new Date().toISOString()
    if (!isSentinel) {
      patch.mnotify_status = rawStatus
      if (row.sms_account_id == null) patch.mnotify_local_status = localStatus
    }
  }

  const { data: updated, error } = await supabaseAdmin
    .from("sms_sender_ids")
    .update(patch)
    .eq("id", id)
    .select()
    .maybeSingle()

  if (error || !updated) return { ok: false, error: error?.message ?? "Sender ID not found" }
  return { ok: true, data: updated as SmsSenderId }
}

/**
 * Manual, provider-call-free local-status overrides. Reject is an
 * admin-side gate that never calls a provider API. Mark Approved exists
 * because a provider's status-check API can be unreliable (Moolre's was
 * broken for months) — an admin who has confirmed real approval out of band
 * (e.g. the provider's own dashboard) needs a way to reflect that here.
 */
async function setSenderIdLocalStatus(
  id: string,
  provider: SenderIdProvider | "both",
  status: "active" | "rejected"
): Promise<ServiceResult<SmsSenderId>> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (provider === "moolre" || provider === "both") patch.local_status = status
  if (provider === "mnotify" || provider === "both") patch.mnotify_local_status = status

  const { data, error } = await supabaseAdmin.from("sms_sender_ids").update(patch).eq("id", id).select().maybeSingle()
  if (error || !data) return { ok: false, error: error?.message ?? "Sender ID not found" }
  return { ok: true, data: data as SmsSenderId }
}

export async function rejectSenderId(
  id: string,
  provider: SenderIdProvider | "both"
): Promise<ServiceResult<SmsSenderId>> {
  return setSenderIdLocalStatus(id, provider, "rejected")
}

export async function approveSenderId(
  id: string,
  provider: SenderIdProvider | "both"
): Promise<ServiceResult<SmsSenderId>> {
  return setSenderIdLocalStatus(id, provider, "active")
}

export interface PollSummary {
  polled: number
  updated: number
  results: { senderId: string; from: string; to: string }[]
}

/**
 * Query each provider for every row that's pending AND has been pushed to
 * that provider, updating its local_status. Returns a summary of which rows
 * changed. Fail-soft per-row: one provider error doesn't abort the rest.
 * A row never pushed to a provider is skipped for that provider — polling
 * before pushing would just repeatedly hit "not found".
 */
export async function pollSenderIds(): Promise<ServiceResult<PollSummary>> {
  const { data: moolrePending, error: moolreErr } = await supabaseAdmin
    .from("sms_sender_ids")
    .select("id, sender_id, local_status")
    .eq("local_status", "pending")
    .is("sms_account_id", null)
    .not("moolre_pushed_at", "is", null)

  if (moolreErr) return { ok: false, error: moolreErr.message }

  const { data: mnotifyPending, error: mnotifyErr } = await supabaseAdmin
    .from("sms_sender_ids")
    .select("id, sender_id, mnotify_local_status")
    .eq("mnotify_local_status", "pending")
    .is("sms_account_id", null)
    .not("mnotify_pushed_at", "is", null)

  if (mnotifyErr) return { ok: false, error: mnotifyErr.message }

  const moolreRows = (moolrePending ?? []) as Pick<SmsSenderId, "id" | "sender_id" | "local_status">[]
  const mnotifyRows = (mnotifyPending ?? []) as Pick<SmsSenderId, "id" | "sender_id" | "mnotify_local_status">[]
  const summary: PollSummary = { polled: moolreRows.length + mnotifyRows.length, updated: 0, results: [] }

  for (const r of moolreRows) {
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

  for (const r of mnotifyRows) {
    const { rawStatus, localStatus } = await queryMnotifySenderIdStatus(r.sender_id)
    const isSentinel = rawStatus === "error" || rawStatus === "no_api_key" || rawStatus === "unknown"

    const patch: Record<string, unknown> = {
      mnotify_last_polled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    if (!isSentinel) {
      patch.mnotify_status = rawStatus
      patch.mnotify_local_status = localStatus
    }

    const { error: updErr } = await supabaseAdmin.from("sms_sender_ids").update(patch).eq("id", r.id)
    if (updErr) continue

    if (!isSentinel && localStatus !== r.mnotify_local_status) {
      summary.updated++
      summary.results.push({ senderId: r.sender_id, from: r.mnotify_local_status, to: localStatus })
    }
  }

  return { ok: true, data: summary }
}
