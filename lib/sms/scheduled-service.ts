/**
 * Scheduled sends (Phase 4a). A scheduled send is a held-shaped log: status 'scheduled' +
 * scheduled_for, credits already debited, its sms_messages 'pending' and unclaimed
 * (claim_sms_messages skips 'scheduled' logs). Each action works on ONE send log.
 *
 *  cancel   — never blocked by the master switch. One SQL transaction
 *             (cancel_scheduled_sms_campaign, migration 20261016): closes the messages, refunds the
 *             unrefunded unsent ones in one ledger row (ref sched_cancel:<logId>), marks the log
 *             failed with review.outcome 'cancelled'. Idempotent. A customer passes their account id
 *             (another account's log reads as not found); the system (suspended account) passes null.
 *  dispatch — the per-minute cron. Master switch off → do nothing (due logs stay scheduled).
 *             Due logs of suspended accounts are cancelled + refunded first; the rest are promoted
 *             scheduled→queued ONLY through the atomic sms_promote_due_scheduled RPC and dispatched
 *             with the shared claim/dispatch module. Once a log is 'queued' the drain can send any
 *             row this run does not, so per-log failures and the deadline never strand a campaign.
 */
import { createClient } from "@supabase/supabase-js"
import { isSmsEnabled } from "./kill-switch"
import { claimPendingForLog, dispatchClaimed, DISPATCH_WINDOW_MS } from "./dispatch-claimed"
import { parseLogId } from "./held-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const NOTIFY_TYPE = "sms_scheduled_cancelled"
const MAX_REASON = 500
export const SUSPENDED_CANCEL_REASON = "account suspended"

export type ScheduledErrorCode = "INVALID" | "NOT_FOUND" | "NOT_SCHEDULED" | "DB"
export type ScheduledError = { ok: false; code: ScheduledErrorCode; error: string }
export type CancelResult = { ok: true; already: boolean; refunded: number } | ScheduledError

const fail = (code: ScheduledErrorCode, error: string): ScheduledError => ({ ok: false, code, error })

interface CancelRow { out_result: "cancelled" | "already_cancelled" | "not_scheduled" | "not_found"; out_refunded: number | null }

async function ownerOfAccount(accountId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin.from("sms_accounts").select("user_id").eq("id", accountId).maybeSingle()
    return (data as { user_id?: string } | null)?.user_id ?? null
  } catch {
    return null
  }
}

async function accountOfLog(logId: number): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin.from("sms_send_logs").select("sms_account_id").eq("id", logId).maybeSingle()
    return (data as { sms_account_id?: string } | null)?.sms_account_id ?? null
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
    if (error) console.error("[SMS-SCHEDULED] customer notification failed:", error.message)
  } catch (e) {
    console.error("[SMS-SCHEDULED] customer notification threw:", e)
  }
}

/**
 * Cancel one scheduled log and refund its unsent messages. `accountId` = the caller's account
 * (ownership enforced in SQL), or null for a system cancel. Not gated by the master switch.
 */
export async function cancelScheduledCampaign(accountId: string | null, rawLogId: string | number, reason: string): Promise<CancelResult> {
  const logId = parseLogId(rawLogId)
  if (logId === null) return fail("INVALID", "Invalid campaign id")
  const why = (typeof reason === "string" ? reason.trim() : "").slice(0, MAX_REASON)

  const { data, error } = await supabaseAdmin.rpc("cancel_scheduled_sms_campaign", {
    p_send_log_id: logId, p_account_id: accountId, p_reason: why || "cancelled",
  })
  if (error) {
    console.error("[SMS-SCHEDULED] cancel RPC failed:", error.message)
    return fail("DB", "Could not cancel the scheduled campaign")
  }
  const row = (Array.isArray(data) ? data[0] : data) as CancelRow | null | undefined
  if (!row || row.out_result === "not_found") return fail("NOT_FOUND", "Campaign not found")
  if (row.out_result === "already_cancelled") return { ok: true, already: true, refunded: 0 }
  if (row.out_result !== "cancelled") {
    return fail("NOT_SCHEDULED", "This campaign is no longer scheduled, so it can't be cancelled (it may already be sending).")
  }

  const refunded = Number(row.out_refunded) || 0
  if (accountId !== null || why) {
    const acct = accountId ?? (await accountOfLog(logId))
    const owner = acct ? await ownerOfAccount(acct) : null
    const refundLine = refunded > 0
      ? ` ${refunded} ${refunded === 1 ? "credit has" : "credits have"} been refunded to your SMS balance.`
      : ""
    const body = accountId !== null
      ? `Your scheduled SMS campaign #${logId} was cancelled and will not be sent.${refundLine}`
      : `Your scheduled SMS campaign #${logId} was cancelled and not sent (${why.replace(/[.!?\s]+$/, "")}).${refundLine}`
    await notifyOwner(owner, logId, "Scheduled SMS cancelled", body)
  }
  return { ok: true, already: false, refunded }
}

export interface DispatchSummary {
  promoted: number
  dispatched: number
  placed: number
  cancelled: number
  /** Promoted after the deadline: left 'queued' with pending messages; the drain sends them. */
  deferred: number
  errors: number
}
export type ScheduledRunResult = DispatchSummary | { skipped: "sms_disabled" }

interface DueRow { id: number | string; sms_account_id: string }
interface PromotedRow { out_id: number | string; out_account_id: string; out_sender_id: string | null }

/**
 * Per-minute cron body. `deadlineMs`: stop STARTING new logs after this. `hardDeadlineMs`
 * (optional): each log's dispatch window (claimedAt + DISPATCH_WINDOW_MS) is capped to end by
 * then, so a log started late can't outlive the function.
 */
export async function runScheduledDispatch(opts: { limit?: number; deadlineMs: number; hardDeadlineMs?: number }): Promise<ScheduledRunResult> {
  const limit = Math.max(1, Math.floor(opts.limit ?? 50))
  if (!(await isSmsEnabled())) {
    console.log("[SMS-SCHEDULED] SMS is switched off; due scheduled sends stay scheduled")
    return { skipped: "sms_disabled" }
  }
  const s: DispatchSummary = { promoted: 0, dispatched: 0, placed: 0, cancelled: 0, deferred: 0, errors: 0 }

  // (1) The due window, in the exact order the promote RPC uses.
  const { data: dueData, error: dueErr } = await supabaseAdmin
    .from("sms_send_logs")
    .select("id, sms_account_id")
    .eq("status", "scheduled")
    .lte("scheduled_for", new Date().toISOString())
    .order("scheduled_for", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit)
  if (dueErr) {
    console.error("[SMS-SCHEDULED] due-log select failed:", dueErr.message)
    s.errors++
    return s
  }
  const due = (dueData ?? []) as DueRow[]
  if (due.length === 0) return s

  // (2) Suspended accounts: cancel + refund BEFORE promotion. If we can't tell, don't promote.
  const accountIds = [...new Set(due.map((d) => d.sms_account_id))]
  const { data: suspData, error: suspErr } = await supabaseAdmin
    .from("sms_accounts")
    .select("id")
    .in("id", accountIds)
    .eq("status", "suspended")
  if (suspErr) {
    console.error("[SMS-SCHEDULED] suspension lookup failed; not promoting this tick:", suspErr.message)
    s.errors++
    return s
  }
  const suspended = new Set(((suspData ?? []) as { id: string }[]).map((a) => a.id))

  // The promote RPC takes the oldest due logs. Promote only as many as the run of checked,
  // non-suspended logs ahead of the first suspended log we FAILED to cancel, so that log (still
  // 'scheduled') can never fall inside the promote window. Newly due logs sort after these.
  let promoteLimit = 0
  let blocked = false
  for (const d of due) {
    if (!suspended.has(d.sms_account_id)) {
      if (!blocked) promoteLimit++
      continue
    }
    let cancelled = false
    try {
      const r = await cancelScheduledCampaign(null, d.id, SUSPENDED_CANCEL_REASON)
      // NOT_SCHEDULED / NOT_FOUND: no longer scheduled, so the promote RPC can't take it either.
      cancelled = r.ok || r.code === "NOT_SCHEDULED" || r.code === "NOT_FOUND"
      if (r.ok && !r.already) s.cancelled++
      if (!r.ok && r.code !== "NOT_SCHEDULED" && r.code !== "NOT_FOUND") {
        console.error(`[SMS-SCHEDULED] cancel of suspended log ${d.id} failed: ${r.error}`)
      }
    } catch (e) {
      console.error(`[SMS-SCHEDULED] cancel of suspended log ${d.id} threw:`, e)
    }
    if (!cancelled) {
      s.errors++
      blocked = true
    }
  }
  if (promoteLimit === 0) return s

  // (3) Promote: the atomic gate (FOR UPDATE SKIP LOCKED; concurrent runs/cancels are safe).
  const { data: promData, error: promErr } = await supabaseAdmin.rpc("sms_promote_due_scheduled", { p_limit: promoteLimit })
  if (promErr) {
    console.error("[SMS-SCHEDULED] promote RPC failed:", promErr.message)
    s.errors++
    return s
  }
  const promoted = ((promData ?? []) as PromotedRow[])
  s.promoted = promoted.length

  // (4) Dispatch each promoted log. Past the deadline, leave the rest queued for the drain.
  for (const p of promoted) {
    if (Date.now() >= opts.deadlineMs) {
      s.deferred++
      continue
    }
    const logId = Number(p.out_id)
    try {
      const now = Date.now()
      const claimedAtMs = opts.hardDeadlineMs !== undefined ? Math.min(now, opts.hardDeadlineMs - DISPATCH_WINDOW_MS) : now
      const items = await claimPendingForLog(supabaseAdmin, logId)
      s.placed += await dispatchClaimed(supabaseAdmin, logId, items, p.out_sender_id ?? null, claimedAtMs)
      s.dispatched++
    } catch (e) {
      // The log is 'queued' with pending (or soon reaped) messages: the drain sends them.
      console.error(`[SMS-SCHEDULED] dispatch of log ${logId} failed; the drain will send it:`, e)
      s.errors++
    }
  }
  return s
}
