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
import { dispatchCampaign, type SentRow } from "./campaign-dispatch"
import { writeAuditLog } from "./moderation-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

/** Must match send-drain's MAX_ATTEMPTS / recompute_sms_send_result's default. */
const MAX_ATTEMPTS = 3
/** Same as enqueueSend: stop starting chunks 1 min before the drain's 5-min stale-claim reaper. */
const DISPATCH_WINDOW_MS = 4 * 60_000
const NOTIFY_TYPE = "sms_campaign_review"
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
  if (["queued", "sending", "sent", "partial", "failed"].includes(log.status)) {
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

/**
 * Dispatch rows this caller has claimed, exactly as enqueueSend step 7 does (that code lives in
 * send-service and is not exported): per-chunk mark-sent with retries and a plain-update fallback,
 * Hubtel "unknown" tagging, first batch id on the log, unplaced rows handed back to the drain,
 * then the parent status rollup. Returns how many rows a provider accepted.
 */
async function dispatchClaimed(
  sendLogId: number,
  items: { id: string; phone: string; message: string }[],
  senderId: string | null,
  claimedAtMs: number,
): Promise<number> {
  const placedUnmarked = new Set<string>()
  let placed = 0
  try {
    if (items.length > 0) {
      const mark = async (provider: string, rows: SentRow[], info: { unconfirmed: boolean }) => {
        if (rows.length === 0) return
        let error: { message?: string } | null = null
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 250 : 1000))
          ;({ error } = await supabaseAdmin.rpc("mark_sms_messages_sent", { p_provider: provider, p_rows: rows }))
          if (!error) break
        }
        if (error) {
          console.error(`[SMS-HELD] mark-sent RPC (${provider}) failed after retries; trying plain update:`, error.message)
          const ids = rows.map((r) => r.id)
          const { error: fbErr } = await supabaseAdmin
            .from("sms_messages")
            .update({ status: "sent", provider, processed_at: new Date().toISOString() })
            .in("id", ids)
            .eq("status", "claimed")
          if (fbErr) {
            console.error(`[SMS-HELD] mark-sent fallback (${provider}) failed; rows held for the reaper:`, fbErr.message)
            for (const id of ids) placedUnmarked.add(id)
            return
          }
        }
        if (provider === "hubtel" && info.unconfirmed) {
          const { error: tagErr } = await supabaseAdmin
            .from("sms_messages")
            .update({ last_error: "hubtel_unconfirmed" })
            .in("id", rows.map((r) => r.id))
          if (tagErr) console.error("[SMS-HELD] unconfirmed tagging failed:", tagErr.message)
        }
      }
      const result = await dispatchCampaign(items, senderId, mark, claimedAtMs + DISPATCH_WINDOW_MS)
      placed = result.sent.length + result.fallbackSent.length
      const firstBatch = result.sent.find((r) => r.bid)?.bid
      if (firstBatch) {
        await supabaseAdmin.from("sms_send_logs").update({ provider_batch_id: firstBatch, provider: "hubtel" }).eq("id", sendLogId)
      }
    }
  } catch (e) {
    console.error("[SMS-HELD] dispatch failed (rows stay pending for the drain):", e)
  } finally {
    try {
      let rel = supabaseAdmin
        .from("sms_messages")
        .update({ status: "pending", claimed_at: null })
        .eq("send_log_id", sendLogId)
        .eq("status", "claimed")
      if (placedUnmarked.size > 0) rel = rel.not("id", "in", `(${[...placedUnmarked].join(",")})`)
      const { error: relErr } = await rel
      if (relErr) console.error("[SMS-HELD] release of unplaced rows failed (stale-claim reaper will recover):", relErr.message)
    } catch (e) {
      console.error("[SMS-HELD] release of unplaced rows threw (stale-claim reaper will recover):", e)
    }
  }
  try {
    const { error } = await supabaseAdmin.rpc("recompute_sms_send_result", { p_send_log_id: sendLogId, max_attempts: MAX_ATTEMPTS })
    if (error) console.warn("[SMS-HELD] recompute failed:", error)
  } catch { /* non-fatal: the drain recomputes too */ }
  return placed
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
  const claimedAt = new Date()
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from("sms_messages")
    .update({ status: "claimed", claimed_at: claimedAt.toISOString() })
    .eq("send_log_id", logId)
    .eq("status", "pending")
    .select("id, phone, rendered_message")
  if (claimErr) console.error("[SMS-HELD] claim failed; the drain will send the campaign:", claimErr.message)
  const items = ((claimErr ? [] : claimed ?? []) as { id: string; phone: string; rendered_message: string }[])
    .map((m) => ({ id: m.id, phone: m.phone, message: m.rendered_message }))

  const placed = await dispatchClaimed(logId, items, log.sender_id ?? null, claimedAt.getTime())

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
