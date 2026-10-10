/**
 * Sender-ID requests and account modes (spec §5.7, §5.6). Approval is ours — Hubtel needs no
 * registration — so an approved ID is active immediately. The DB guarantees no two ACTIVE
 * rows share a name (uq_sms_sender_ids_active_name); we check first for a friendly error.
 */
import { createClient } from "@supabase/supabase-js"
import { validateSenderName } from "./sender-name"
import { loadSmsSettings, type SmsMode } from "./platform-settings"
import { writeAuditLog } from "./moderation-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

type Result<T> = { ok: true; data: T } | { ok: false; error: string }
export interface SenderRow { id: string; sender_id: string; sms_account_id: string; local_status: string; kyc_free: boolean; created_at: string }

const COLS = "id, sender_id, sms_account_id, local_status, kyc_free, created_at"
const OPEN_STATUSES = ["pending", "active", "paused"]
export function senderLimitFor(mode: SmsMode): number {
  return mode === "business" ? 200 : 1
}

export interface ModePlan { unpause: string[]; pause: string[]; markKycFree: string | null }
/** rows oldest-first. Pure. */
export function planModeChange(target: SmsMode, rows: { id: string; local_status: string; kyc_free: boolean }[]): ModePlan {
  if (target === "business") {
    return { unpause: rows.filter((r) => r.local_status === "paused").map((r) => r.id), pause: [], markKycFree: null }
  }
  const active = rows.filter((r) => r.local_status === "active")
  const keep = active.find((r) => r.kyc_free) ?? active[0]
  if (!keep) return { unpause: [], pause: [], markKycFree: null }
  return {
    unpause: [],
    pause: active.filter((r) => r.id !== keep.id).map((r) => r.id),
    markKycFree: keep.kyc_free ? null : keep.id,
  }
}

async function accountMode(accountId: string): Promise<{ mode: SmsMode; default_sender_id: string | null } | null> {
  const { data } = await supabaseAdmin.from("sms_accounts").select("mode, default_sender_id").eq("id", accountId).maybeSingle()
  return (data as { mode: SmsMode; default_sender_id: string | null } | null) ?? null
}

async function activeElsewhere(name: string, accountId: string): Promise<boolean> {
  const { data } = await supabaseAdmin.from("sms_sender_ids").select("id")
    .eq("sender_id", name).eq("local_status", "active")
    .or(`sms_account_id.is.null,sms_account_id.neq.${accountId}`).limit(1)
  return (data ?? []).length > 0
}

const isUniqueViolation = (e: { code?: string } | null) => e?.code === "23505"
const IN_USE = "That sender ID is already in use by another account."

/** Customer request. Idempotent for an open request of the same name; re-opens a rejected/revoked one. */
export async function requestSenderId(accountId: string, raw: string): Promise<Result<SenderRow>> {
  const settings = await loadSmsSettings()
  const check = validateSenderName(raw, settings.protectedSenderNames)
  if (!check.ok) return { ok: false, error: check.reason }
  const name = check.name

  const acct = await accountMode(accountId)
  if (!acct) return { ok: false, error: "SMS account not found" }

  const { data: rowsData } = await supabaseAdmin.from("sms_sender_ids").select(COLS).eq("sms_account_id", accountId)
  const rows = (rowsData ?? []) as SenderRow[]
  const existing = rows.find((r) => r.sender_id.toUpperCase() === name)
  if (existing && OPEN_STATUSES.includes(existing.local_status)) return { ok: true, data: existing }

  const open = rows.filter((r) => OPEN_STATUSES.includes(r.local_status)).length
  if (open >= senderLimitFor(acct.mode)) {
    return {
      ok: false,
      error: acct.mode === "platform"
        ? "Platform mode includes one sender ID. Verify your business to request up to 200."
        : "You've reached the limit of 200 sender IDs.",
    }
  }
  if (await activeElsewhere(name, accountId)) return { ok: false, error: IN_USE }

  if (existing) {
    const now = new Date().toISOString()
    const { data, error } = await supabaseAdmin.from("sms_sender_ids")
      .update({ local_status: "pending", rejection_reason: null, revoked_at: null, kyc_free: acct.mode === "platform", submitted_at: now, updated_at: now })
      .eq("id", existing.id).select(COLS).single()
    if (isUniqueViolation(error)) return { ok: false, error: IN_USE }
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: data as SenderRow }
  }
  const { data, error } = await supabaseAdmin.from("sms_sender_ids")
    .insert({ sender_id: name, sms_account_id: accountId, local_status: "pending", kyc_free: acct.mode === "platform" })
    .select(COLS).single()
  if (isUniqueViolation(error)) return { ok: false, error: IN_USE }
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: data as SenderRow }
}

async function getRow(id: string): Promise<SenderRow | null> {
  const { data } = await supabaseAdmin.from("sms_sender_ids").select(COLS).eq("id", id).maybeSingle()
  return (data as SenderRow | null) ?? null
}

export async function approveSenderIdRequest(adminId: string | null, id: string): Promise<Result<SenderRow>> {
  const row = await getRow(id)
  if (!row || !row.sms_account_id) return { ok: false, error: "Sender ID not found" }
  if (row.local_status !== "pending") return { ok: false, error: `Only pending requests can be approved (this one is ${row.local_status}).` }
  const acct = await accountMode(row.sms_account_id)
  if (!acct) return { ok: false, error: "SMS account not found" }
  if (acct.mode === "platform") {
    const { data: free } = await supabaseAdmin.from("sms_sender_ids").select("id")
      .eq("sms_account_id", row.sms_account_id).eq("local_status", "active").neq("id", id).limit(1)
    if ((free ?? []).length > 0) return { ok: false, error: "This Platform account already has its one sender ID. Revoke it first or approve after business verification." }
  }
  if (await activeElsewhere(row.sender_id, row.sms_account_id)) return { ok: false, error: "Another account already uses this sender ID." }

  const now = new Date().toISOString()
  const { data, error } = await supabaseAdmin.from("sms_sender_ids")
    .update({ local_status: "active", approved_by: adminId, approved_at: now, rejection_reason: null, kyc_free: acct.mode === "platform" ? true : row.kyc_free, updated_at: now })
    .eq("id", id).eq("local_status", "pending")
    .select(COLS).maybeSingle()
  if (isUniqueViolation(error)) return { ok: false, error: "Another account already uses this sender ID." }
  if (error || !data) return { ok: false, error: error?.message ?? "Request changed — refresh and try again." }
  if (!acct.default_sender_id) {
    await supabaseAdmin.from("sms_accounts").update({ default_sender_id: id }).eq("id", row.sms_account_id)
  }
  if (adminId) writeAuditLog(adminId, "sms_sender_approve", null, { id, status: "pending" }, { id, status: "active" }).catch(() => {})
  return { ok: true, data: data as SenderRow }
}

export async function rejectSenderIdRequest(adminId: string | null, id: string, reason: string): Promise<Result<SenderRow>> {
  const why = (reason ?? "").trim()
  if (why.length < 3) return { ok: false, error: "A rejection reason is required." }
  const { data, error } = await supabaseAdmin.from("sms_sender_ids")
    .update({ local_status: "rejected", rejection_reason: why, updated_at: new Date().toISOString() })
    .eq("id", id).eq("local_status", "pending")
    .select(COLS).maybeSingle()
  if (error || !data) return { ok: false, error: error?.message ?? "Only pending requests can be rejected." }
  if (adminId) writeAuditLog(adminId, "sms_sender_reject", null, { id }, { id, reason: why }).catch(() => {})
  return { ok: true, data: data as SenderRow }
}

export async function revokeSenderId(adminId: string | null, id: string, reason?: string): Promise<Result<SenderRow>> {
  const now = new Date().toISOString()
  const { data, error } = await supabaseAdmin.from("sms_sender_ids")
    .update({ local_status: "revoked", revoked_at: now, kyc_free: false, rejection_reason: reason?.trim() || null, updated_at: now })
    .eq("id", id).in("local_status", ["active", "paused"])
    .select(COLS).maybeSingle()
  if (error || !data) return { ok: false, error: error?.message ?? "Only active or paused sender IDs can be revoked." }
  // A revoked default falls back to the platform sender.
  await supabaseAdmin.from("sms_accounts").update({ default_sender_id: null }).eq("default_sender_id", id)
  if (adminId) writeAuditLog(adminId, "sms_sender_revoke", null, { id }, { id, reason: reason ?? null }).catch(() => {})
  return { ok: true, data: data as SenderRow }
}

/** Switch an account's mode, pausing/unpausing sender IDs per planModeChange. */
export async function setAccountMode(adminId: string | null, accountId: string, mode: SmsMode): Promise<Result<{ mode: SmsMode; unpaused: number; paused: number; conflicts: string[] }>> {
  const { data: rowsData, error: rowsErr } = await supabaseAdmin.from("sms_sender_ids")
    .select(COLS).eq("sms_account_id", accountId).order("created_at", { ascending: true })
  if (rowsErr) return { ok: false, error: rowsErr.message }
  const rows = (rowsData ?? []) as SenderRow[]
  const plan = planModeChange(mode, rows)
  const now = new Date().toISOString()

  const { error: accErr } = await supabaseAdmin.from("sms_accounts").update({ mode, mode_changed_at: now }).eq("id", accountId)
  if (accErr) return { ok: false, error: accErr.message }

  if (plan.markKycFree) await supabaseAdmin.from("sms_sender_ids").update({ kyc_free: true, updated_at: now }).eq("id", plan.markKycFree)
  if (plan.pause.length) {
    await supabaseAdmin.from("sms_sender_ids").update({ local_status: "paused", updated_at: now }).in("id", plan.pause)
    await supabaseAdmin.from("sms_accounts").update({ default_sender_id: plan.markKycFree ?? rows.find((r) => r.kyc_free && r.local_status === "active")?.id ?? null })
      .eq("id", accountId).in("default_sender_id", plan.pause)
  }
  // Unpause one by one: a name that became active on another account meanwhile stays paused.
  const conflicts: string[] = []
  let unpaused = 0
  for (const id of plan.unpause) {
    const { error } = await supabaseAdmin.from("sms_sender_ids").update({ local_status: "active", updated_at: now }).eq("id", id).eq("local_status", "paused")
    if (isUniqueViolation(error)) conflicts.push(rows.find((r) => r.id === id)?.sender_id ?? id)
    else if (!error) unpaused++
  }
  if (adminId) writeAuditLog(adminId, "sms_account_mode", null, { accountId }, { accountId, mode, ...plan, conflicts }).catch(() => {})
  return { ok: true, data: { mode, unpaused, paused: plan.pause.length, conflicts } }
}

export async function setApiRateLimitOverride(adminId: string | null, accountId: string, value: number | null): Promise<Result<{ api_rate_limit_override: number | null }>> {
  if (value !== null && !(Number.isInteger(value) && value >= 1 && value <= 10_000)) {
    return { ok: false, error: "Rate limit must be a whole number from 1 to 10,000 (or empty for the default)." }
  }
  const { error } = await supabaseAdmin.from("sms_accounts").update({ api_rate_limit_override: value }).eq("id", accountId)
  if (error) return { ok: false, error: error.message }
  if (adminId) writeAuditLog(adminId, "sms_account_rate_limit", null, { accountId }, { accountId, value }).catch(() => {})
  return { ok: true, data: { api_rate_limit_override: value } }
}
