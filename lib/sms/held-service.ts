/**
 * Held campaigns (Phase 3b): an enforced 'hold' decision stores the campaign with status 'held',
 * credits already debited and its sms_messages inserted as plain 'pending' (never claimed — the
 * drain's claim skips held logs). An admin then releases (sends) or rejects (refunds) it.
 *
 * Each action works on ONE send log (a held send of >500 recipients has one held log per chunk).
 *
 *  release — respects the master switch (it is a send). Conditional held→queued is the gate (a
 *            second call, or a concurrent reject, sees a non-held status and does nothing). Then
 *            the same sequence enqueueSend runs after its debit: claim the pending rows, instant
 *            dispatch with per-chunk mark-sent, hand unplaced rows back to the drain, recompute.
 *  reject  — never blocked by the switch. One SQL transaction (reject_held_sms_campaign, migration
 *            20261014): closes the messages while the log is still held, refunds the UNREFUNDED
 *            unsent messages in one ledger row (ref held_reject:<logId>), marks the log failed.
 *
 * Both notify the customer in-app (fail-soft) and write an admin_audit_log row.
 */
import { createClient } from "@supabase/supabase-js"
import { isSmsEnabled } from "./kill-switch"
import { claimPendingForLog, dispatchClaimed } from "./dispatch-claimed"
import { writeAuditLog } from "./moderation-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const NOTIFY_TYPE ="sms_campaign_review"
export const MIN_REJECT_REASON = 3
const MAX_REJECT_REASON = 500

export type HeldErrorCode = "INVALID" | "NOT_FOUND" | "NOT_HELD" | "REJECTED" | "SMS_DISABLED" | "DB"
export type HeldError = { ok: false; code: HeldErrorCode; error: string }
export type ReleaseResult = { ok: true; already: false; placed: number } | { ok: true; already: true; status: string } | HeldError
export type RejectResult = { ok: true; already: boolean; refundedCredits: number; refundedMessages: number } | HeldError

export const SMS_OFF_RELEASE_MESSAGE = "SMS sending is switched off. Turn SMS back on in Settings before releasing held campaigns."

/** sms_send_logs.id is a BIGSERIAL: accept a positive safe integer only. */
export function parseLogId(raw: unknown): number | null {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : ""
  if (!/^[1-9]\d{0,15}$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : null
}

const fail = (code: HeldErrorCode, error: string): HeldError => ({ ok: false, code, error })

interface LogRow { id: number | string; sms_account_id: string; status: string; sender_id: string | null; policy_shadow: Record<string, unknown> | null }

function reviewOutcome(shadow: unknown): string | null {
  const review = (shadow as { review?: { outcome?: unknown } } | null)?.review
  return typeof review?.outcome === "string" ? review.outcome : null
}

/** A non-held log: already released (no-op) or refused. */
function settledRelease(log: Pick<LogRow, "status" | "policy_shadow">): ReleaseResult {
  if (log.status === "failed" && reviewOutcome(log.policy_shadow) === "rejected") {
    return fail("REJECTED", "This campaign was rejected; it can't be released.")
  }
  if (["queued", "sending", "sent", "partial"].includes(log.status)) {
    return { ok: true, already: true, status: log.status }
  }
  // 'failed' counts as already released only if a release actually happened; an orphan log that
  // enqueueSend closed as failed (refunded, nothing sent) was never released.
  if (log.status === "failed" && reviewOutcome(log.policy_shadow) === "released") {
    return { ok: true, already: true, status: log.status }
  }
  return fail("NOT_HELD", `This campaign is not held for review (status: ${log.status}).`)
}

async function ownerOf(accountId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin.from("sms_accounts").select("user_id").eq("id", accountId).maybeSingle()
    return (data as { user_id?: string } | null)?.user_id ?? null
  } catch {
    return null
  }
}

/** In-app notification to the campaign owner. Never throws. */
async function notifyOwner(userId: string | null, logId: number, title: string, message: string): Promise<void> {
  if (!userId) return
  try {
    const now = new Date().toISOString()
    const { error } = await supabaseAdmin.from("notifications").insert({
      user_id: userId, title, message, type: NOTIFY_TYPE, read: false,
      action_url: `/dashboard/sms/records/${logId}`, created_at: now, updated_at: now,
    })
    if (error) console.error("[SMS-HELD] customer notification failed:", error.message)
  } catch (e) {
    console.error("[SMS-HELD] customer notification threw:", e)
  }
}

async function audit(adminId: string, action: string, target: string | null, oldValue: unknown, newValue: unknown) {
  try {
    await writeAuditLog(adminId, action, target, oldValue, newValue)
  } catch (e) {
    console.error(`[SMS-HELD] audit (${action}) failed:`, e)
  }
}

export async function releaseHeldCampaign(adminId: string, rawLogId: string | number): Promise<ReleaseResult> {
  const logId = parseLogId(rawLogId)
  if (logId === null) return fail("INVALID", "Invalid campaign id")

  const { data, error } = await supabaseAdmin
    .from("sms_send_logs")
    .select("id, sms_account_id, status, sender_id, policy_shadow")
    .eq("id", logId)
    .maybeSingle()
  if (error) return fail("DB", "Could not load the campaign")
  const log = data as LogRow | null
  if (!log) return fail("NOT_FOUND", "Campaign not found")
  if (log.status !== "held") return settledRelease(log)

  // Release is a send: honour the master switch (reject is never blocked).
  if (!(await isSmsEnabled())) return fail("SMS_DISABLED", SMS_OFF_RELEASE_MESSAGE)

  // The gate: conditional held→queued. A concurrent release/reject makes this match nothing.
  const shadow = log.policy_shadow && typeof log.policy_shadow === "object" ? log.policy_shadow : {}
  const { data: flipped, error: flipErr } = await supabaseAdmin
    .from("sms_send_logs")
    .update({ status: "queued", policy_shadow: { ...shadow, review: { outcome: "released", by: adminId, at: new Date().toISOString() } } })
    .eq("id", logId)
    .eq("status", "held")
    .select("id")
  if (flipErr) return fail("DB", "Could not release the campaign")
  if (!flipped || (flipped as unknown[]).length === 0) {
    const { data: again } = await supabaseAdmin
      .from("sms_send_logs").select("id, sms_account_id, status, sender_id, policy_shadow").eq("id", logId).maybeSingle()
    if (!again) return fail("DB", "Could not release the campaign")
    return (again as LogRow).status === "held" ? fail("DB", "Could not release the campaign") : settledRelease(again as LogRow)
  }

  // From here the campaign is an ordinary queued send: the drain may take any row we don't.
  // Claim the still-pending rows for an instant dispatch (conditional, so no row is double-claimed).
  const claimedAtMs = Date.now()
  const items = await claimPendingForLog(supabaseAdmin, logId)

  const placed = await dispatchClaimed(supabaseAdmin, logId, items, log.sender_id ?? null, claimedAtMs)

  const owner = await ownerOf(log.sms_account_id)
  await notifyOwner(owner, logId, "SMS campaign approved",
    `Your SMS campaign #${logId} was approved after review and is being sent now.`)
  await audit(adminId, "sms_held_release", owner, { logId, status: "held" }, { status: "queued", placed })
  return { ok: true, already: false, placed }
}

interface RejectRow {
  out_outcome: "rejected" | "already_rejected" | "not_held" | "not_found"
  out_status: string | null
  out_account_id: string | null
  out_refunded_messages: number | null
  out_refunded_credits: number | null
}

export async function rejectHeldCampaign(adminId: string, rawLogId: string | number, rawReason: string): Promise<RejectResult> {
  const logId = parseLogId(rawLogId)
  if (logId === null) return fail("INVALID", "Invalid campaign id")
  const reason = typeof rawReason === "string" ? rawReason.trim().slice(0, MAX_REJECT_REASON) : ""
  if (reason.length < MIN_REJECT_REASON) return fail("INVALID", `Give a reason (at least ${MIN_REJECT_REASON} characters)`)

  const { data, error } = await supabaseAdmin.rpc("reject_held_sms_campaign", {
    p_send_log_id: logId, p_reason: reason, p_admin_id: adminId,
  })
  if (error) {
    console.error("[SMS-HELD] reject RPC failed:", error.message)
    return fail("DB", "Could not reject the campaign")
  }
  const row = (Array.isArray(data) ? data[0] : data) as RejectRow | null
  if (!row || row.out_outcome === "not_found") return fail("NOT_FOUND", "Campaign not found")
  if (row.out_outcome === "already_rejected") return { ok: true, already: true, refundedCredits: 0, refundedMessages: 0 }
  if (row.out_outcome !== "rejected") {
    return fail("NOT_HELD", `This campaign is no longer held for review (status: ${row.out_status ?? "unknown"}).`)
  }

  const refundedCredits = Number(row.out_refunded_credits) || 0
  const refundedMessages = Number(row.out_refunded_messages) || 0
  const owner = row.out_account_id ? await ownerOf(row.out_account_id) : null
  const refundLine = refundedCredits > 0
    ? ` ${refundedCredits} ${refundedCredits === 1 ? "credit has" : "credits have"} been refunded to your SMS balance.`
    : ""
  await notifyOwner(owner, logId, "SMS campaign not approved",
    `Your SMS campaign #${logId} was not sent after review. Reason: ${reason.replace(/[.!?\s]+$/, "")}.${refundLine}`)
  await audit(adminId, "sms_held_reject", owner, { logId, status: "held" }, { status: "failed", reason, refundedCredits, refundedMessages })
  return { ok: true, already: false, refundedCredits, refundedMessages }
}
