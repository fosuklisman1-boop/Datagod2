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

interface AccountInfo { mode: SmsMode; default_sender_id: string | null; user_id: string | null }
async function accountInfo(accountId: string): Promise<AccountInfo | null> {
  const { data } = await supabaseAdmin.from("sms_accounts").select("mode, default_sender_id, user_id").eq("id", accountId).maybeSingle()
  return (data as AccountInfo | null) ?? null
}

async function activeElsewhere(name: string, accountId: string): Promise<boolean> {
  const { data } = await supabaseAdmin.from("sms_sender_ids").select("id")
    .eq("sender_id", name).eq("local_status", "active")
    .or(`sms_account_id.is.null,sms_account_id.neq.${accountId}`).limit(1)
  return (data ?? []).length > 0
}

const isUniqueViolation = (e: { code?: string } | null) => e?.code === "23505"
/** Every tenant sender-ID / mode decision must be attributable to an admin user. */
const NO_ADMIN = { ok: false, error: "Admin user required" } as const
const IN_USE ="That sender ID is already in use by another account."

/** Audit row targeting the account owner. Never throws; skipped without an admin id. */
async function audit(adminId: string | null, action: string, accountId: string | null, oldValue: unknown, newValue: unknown): Promise<void> {
  if (!adminId) return
  try {
    const owner = accountId ? (await accountInfo(accountId))?.user_id ?? null : null
    await writeAuditLog(adminId, action, owner, oldValue, newValue)
  } catch (err) {
    console.error("[SMS-AUDIT] sender rules audit failed:", err)
  }
}

/** Customer request. Idempotent for an open request of the same name; re-opens a rejected/revoked one. */
export async function requestSenderId(accountId: string, raw: string): Promise<Result<SenderRow>> {
  const settings = await loadSmsSettings()
  const check = validateSenderName(raw, settings.protectedSenderNames)
  if (!check.ok) return { ok: false, error: check.reason }
  const name = check.name

  const acct = await accountInfo(accountId)
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
    // Clear every legacy provider-push field so the provider pollers can never pick this row up and
    // activate it behind our back (approval is ours).
    const { data, error } = await supabaseAdmin.from("sms_sender_ids")
      .update({
        local_status: "pending", rejection_reason: null, revoked_at: null, kyc_free: acct.mode === "platform",
        moolre_pushed_at: null, mnotify_pushed_at: null, moolre_status: null, mnotify_status: null, mnotify_local_status: "pending",
        submitted_at: now, updated_at: now,
      })
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
  if (!adminId) return NO_ADMIN
  const row = await getRow(id)
  if (!row || !row.sms_account_id) return { ok: false, error: "Sender ID not found" }
  if (row.local_status !== "pending") return { ok: false, error: `Only pending requests can be approved (this one is ${row.local_status}).` }
  const acct = await accountInfo(row.sms_account_id)
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
  await audit(adminId, "sms_sender_approve", row.sms_account_id,
    { id, sender_id: row.sender_id, sms_account_id: row.sms_account_id, status: "pending" },
    { id, sender_id: row.sender_id, sms_account_id: row.sms_account_id, status: "active", mode: acct.mode, kyc_free: (data as SenderRow).kyc_free })
  return { ok: true, data: data as SenderRow }
}

export async function rejectSenderIdRequest(adminId: string | null, id: string, reason: string): Promise<Result<SenderRow>> {
  if (!adminId) return NO_ADMIN
  const why = (reason ?? "").trim()
  if (why.length < 3) return { ok: false, error: "A rejection reason is required." }
  const { data, error } = await supabaseAdmin.from("sms_sender_ids")
    .update({ local_status: "rejected", rejection_reason: why, updated_at: new Date().toISOString() })
    .eq("id", id).eq("local_status", "pending")
    .select(COLS).maybeSingle()
  if (error || !data) return { ok: false, error: error?.message ?? "Only pending requests can be rejected." }
  const row = data as SenderRow
  await audit(adminId, "sms_sender_reject", row.sms_account_id,
    { id, sender_id: row.sender_id, sms_account_id: row.sms_account_id, status: "pending" },
    { id, sender_id: row.sender_id, sms_account_id: row.sms_account_id, status: "rejected", reason: why })
  return { ok: true, data: row }
}

export async function revokeSenderId(adminId: string | null, id: string, reason?: string): Promise<Result<SenderRow>> {
  if (!adminId) return NO_ADMIN
  const before = await getRow(id)
  const now = new Date().toISOString()
  const { data, error } = await supabaseAdmin.from("sms_sender_ids")
    .update({ local_status: "revoked", revoked_at: now, kyc_free: false, rejection_reason: reason?.trim() || null, updated_at: now })
    .eq("id", id).in("local_status", ["active", "paused"])
    .select(COLS).maybeSingle()
  if (error || !data) return { ok: false, error: error?.message ?? "Only active or paused sender IDs can be revoked." }
  const row = data as SenderRow
  // A revoked default falls back to the platform sender.
  await supabaseAdmin.from("sms_accounts").update({ default_sender_id: null }).eq("default_sender_id", id)
  await audit(adminId, "sms_sender_revoke", row.sms_account_id,
    { id, sender_id: row.sender_id, sms_account_id: row.sms_account_id, status: before?.local_status ?? null },
    { id, sender_id: row.sender_id, sms_account_id: row.sms_account_id, status: "revoked", reason: reason ?? null })
  return { ok: true, data: row }
}

type ModeResult = Result<{ mode: SmsMode; unpaused: number; paused: number; conflicts: string[] }>

/**
 * Switch an account's mode, pausing/unpausing sender IDs per planModeChange. Every write is
 * checked; on failure the error says what was applied and what failed.
 *  → platform: mark kyc_free, pause extras, repoint default, THEN set mode (a failure leaves extras
 *    paused while still in the old mode — the safe direction).
 *  → business: set mode first, then unpause one by one.
 */
export async function setAccountMode(adminId: string | null, accountId: string, mode: SmsMode): Promise<ModeResult> {
  if (!adminId) return NO_ADMIN
  const acct = await accountInfo(accountId)
  if (!acct) return { ok: false, error: "SMS account not found" }
  const { data: rowsData, error: rowsErr } = await supabaseAdmin.from("sms_sender_ids")
    .select(COLS).eq("sms_account_id", accountId).order("created_at", { ascending: true })
  if (rowsErr) return { ok: false, error: rowsErr.message }
  const rows = (rowsData ?? []) as SenderRow[]
  const plan = planModeChange(mode, rows)
  const now = new Date().toISOString()

  const applied: string[] = []
  const conflicts: string[] = []
  let paused = 0
  let unpaused = 0
  let modeSet = false

  const finish = async (failure: string | null): Promise<ModeResult> => {
    if (unpaused) applied.push(`${unpaused} sender ID(s) unpaused`)
    await audit(adminId, "sms_account_mode", accountId,
      { accountId, mode: acct.mode },
      { accountId, requestedMode: mode, modeApplied: modeSet, ...plan, paused, unpaused, conflicts, applied, failure })
    if (failure) {
      return { ok: false, error: `${failure}. Applied: ${applied.length ? applied.join("; ") : "nothing"}. Mode is ${modeSet ? mode : acct.mode}.` }
    }
    return { ok: true, data: { mode, unpaused, paused, conflicts } }
  }
  const setMode = async (): Promise<string | null> => {
    const { error } = await supabaseAdmin.from("sms_accounts").update({ mode, mode_changed_at: now }).eq("id", accountId)
    if (error) return `Failed to set account mode (${error.message})`
    modeSet = true
    applied.push(`mode set to ${mode}`)
    return null
  }

  if (mode === "platform") {
    if (plan.markKycFree) {
      const { error } = await supabaseAdmin.from("sms_sender_ids").update({ kyc_free: true, updated_at: now }).eq("id", plan.markKycFree)
      if (error) return finish(`Failed to mark the free sender ID (${error.message})`)
      applied.push("free sender ID marked")
    }
    if (plan.pause.length) {
      const { data, error } = await supabaseAdmin.from("sms_sender_ids")
        .update({ local_status: "paused", updated_at: now }).in("id", plan.pause).select("id")
      if (error) return finish(`Failed to pause extra sender IDs (${error.message})`)
      paused = (data ?? []).length
      applied.push(`${paused} sender ID(s) paused`)
      const keepId = plan.markKycFree ?? rows.find((r) => r.kyc_free && r.local_status === "active")?.id ?? null
      const { error: defErr } = await supabaseAdmin.from("sms_accounts").update({ default_sender_id: keepId })
        .eq("id", accountId).in("default_sender_id", plan.pause)
      if (defErr) return finish(`Failed to repoint the default sender ID (${defErr.message})`)
    }
    return finish(await setMode())
  }

  const modeFailure = await setMode()
  if (modeFailure) return finish(modeFailure)
  // Unpause one by one: a name that became active on another account meanwhile stays paused.
  for (const id of plan.unpause) {
    const { data, error } = await supabaseAdmin.from("sms_sender_ids")
      .update({ local_status: "active", updated_at: now }).eq("id", id).eq("local_status", "paused").select("id")
    if (isUniqueViolation(error)) conflicts.push(rows.find((r) => r.id === id)?.sender_id ?? id)
    else if (error) return finish(`Failed to unpause a sender ID (${error.message})`)
    else if ((data ?? []).length > 0) unpaused++
  }
  return finish(null)
}

export async function setApiRateLimitOverride(adminId: string | null, accountId: string, value: number | null): Promise<Result<{ api_rate_limit_override: number | null }>> {
  if (!adminId) return NO_ADMIN
  if (value !== null && !(Number.isInteger(value) && value >= 1 && value <= 10_000)) {
    return { ok: false, error: "Rate limit must be a whole number from 1 to 10,000 (or empty for the default)." }
  }
  const { error } = await supabaseAdmin.from("sms_accounts").update({ api_rate_limit_override: value }).eq("id", accountId)
  if (error) return { ok: false, error: error.message }
  await audit(adminId, "sms_account_rate_limit", accountId, { accountId }, { accountId, value })
  return { ok: true, data: { api_rate_limit_override: value } }
}
