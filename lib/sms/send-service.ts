import { createClient } from "@supabase/supabase-js"
import { prepareSmsMessage, type ShopTokens } from "./prepare"
import { filterSmsContent } from "./content-filter"
import { calculateSegments } from "./segments"
import { resolveCampaignSender, shadowPolicyWithin, type PolicyShadow } from "./policy-context"
import { isSmsEnabled } from "./kill-switch"
import { dispatchCampaign, type SentRow } from "./campaign-dispatch"
import {
  evaluateForEnforcement, isPolicyEnforced, recordFlags, releaseSendLock, trySendLock,
  POLICY_UNAVAILABLE_REASON, SEND_IN_PROGRESS_MESSAGE, type EnforcementCode,
} from "./enforcement"
import type { PolicySender } from "./policy"
import type { SmsMode } from "./platform-settings"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const MAX_RECIPIENTS = 500
// Auto-batching: one enqueueSend call carries up to SMS_BATCH_SIZE recipients;
// a larger group/list fans out into sequential batches up to SMS_MAX_TOTAL.
export const SMS_BATCH_SIZE = 500
export const SMS_MAX_TOTAL = 5000

/** Normalize a phone string to +233XXXXXXXXX (Moolre/E.164 format). */
function normalizePhoneNumber(phone: string): string | null {
  const cleaned = String(phone ?? "").replace(/[\s\-\(\)]/g, "")
  if (!cleaned) return null
  if (cleaned.startsWith("0") && cleaned.length === 10) return `+233${cleaned.slice(1)}`
  if (cleaned.startsWith("+233") && cleaned.length === 13) return cleaned
  if (cleaned.startsWith("233") && cleaned.length === 12) return `+${cleaned}`
  if (/^\d{9}$/.test(cleaned)) return `+233${cleaned}`
  return null
}

const NO_TOKENS: ShopTokens = { shop_name: "", shop_link: "", shop_phone: "", shop_whatsapp: "" }

export interface EnqueueSendResult {
  ok: true
  sendLogId: string
  total: number
  segments: number
  creditsReserved: number
  invalidSkipped: number
  /** Present (true) only for an enforced 'hold': debited + stored, NOT dispatched. */
  held?: true
  /** Present only for a scheduled (not held) send: debited + stored 'scheduled', NOT dispatched. */
  scheduled?: true
  /** ISO instant the scheduled send is due (with `scheduled`). */
  scheduledFor?: string
}

/** Optional per-send options (Phase 4). Omitted ⇒ exactly the pre-Phase-4 DB writes. */
export interface EnqueueSendOptions {
  /** Store the send as 'scheduled' for this instant (debited now, dispatched by the cron). */
  scheduledFor?: Date
  /** Log label; written only when non-default (the DB default is 'campaign'). */
  source?: "campaign" | "order_confirmation"
}

export interface EnqueueSendError {
  ok: false
  error:
    | "EMPTY_MESSAGE"
    | "BLOCKED"
    | "TOO_MANY_RECIPIENTS"
    | "NO_VALID_RECIPIENTS"
    | "NOT_ACTIVATED"
    | "SUSPENDED"
    | "INSUFFICIENT_CREDITS"
    | "INVALID_SENDER_ID"
    | "ENQUEUE_FAILED"
    | "SMS_DISABLED"
    | "POLICY_REJECTED"
    | "SEND_IN_PROGRESS"
  /** Customer-safe text only (never matched keywords / flag details). */
  reason?: string
  /** Policy code, set with POLICY_REJECTED. */
  code?: EnforcementCode
}

/**
 * The enforced decision for a chunk, decided ONCE per user send by enqueueSendBatched.
 * Absent ⇒ record-only behaviour (exactly as before enforcement existed).
 */
export interface ChunkPolicy {
  decision: "allow" | "hold"
  mode: SmsMode
  shadow: PolicyShadow
}

/**
 * Validate, filter, debit credits, and enqueue an SMS send for the cron drain.
 * Bills ONLY deliverable (valid-phone) recipients, and refunds the reservation if the
 * queue insert fails after the debit. Fires a best-effort initial drain.
 *
 * (userId is accepted for signature/route stability; the account already scopes everything.)
 */
export async function enqueueSend(
  _userId: string,
  accountId: string,
  message: string,
  recipients: string[],
  shopTokens?: ShopTokens,
  senderId?: string,
  enforced?: ChunkPolicy,
  /** Enforced sends only: called once this chunk's log + messages are durably inserted, BEFORE
   *  any dispatch (lets the batch orchestrator release the per-account lease early). */
  onLogged?: (sendLogId: string) => Promise<void>,
  opts?: EnqueueSendOptions
): Promise<EnqueueSendResult | EnqueueSendError> {
  // An enforced 'hold': debit + store the campaign, but never dispatch it (admin releases it).
  const held = enforced?.decision === "hold"

  // Scheduled send (Phase 4a): debit + store now, dispatched later by the sms-scheduled cron.
  // Callers validate the bounds (checkSchedule); an unusable Date here is refused before any write.
  const scheduledFor = opts?.scheduledFor
  if (scheduledFor !== undefined && !(scheduledFor instanceof Date && Number.isFinite(scheduledFor.getTime()))) {
    return { ok: false, error: "ENQUEUE_FAILED" }
  }
  const scheduledIso = scheduledFor ? scheduledFor.toISOString() : null
  // A policy hold wins over scheduling: stored 'held' (scheduled_for kept for information).
  const scheduled = scheduledIso !== null && !held
  // Pending + unclaimed messages, no dispatch / release / recompute here.
  const deferred = held || scheduled
  // New columns are written ONLY when asked for, so ordinary sends work before the migration.
  const extraLogCols: Record<string, string> = {}
  if (scheduledIso !== null) extraLogCols.scheduled_for = scheduledIso
  if (opts?.source && opts.source !== "campaign") extraLogCols.source = opts.source

  // 0. Master switch (Phase 2): refuse new customer sends while the platform switch is off.
  if (!(await isSmsEnabled())) return { ok: false, error: "SMS_DISABLED" }

  // 1. Recipient cap (before any debit).
  if (recipients.length > MAX_RECIPIENTS) {
    return { ok: false, error: "TOO_MANY_RECIPIENTS" }
  }

  // 1b. Resolve the chosen sender (before any debit): own ACTIVE IDs only (paused/revoked
  //     never resolve), or a pool name for business accounts. Omitted → platform default.
  const sender = await resolveCampaignSender(accountId, senderId)
  if (!sender) return { ok: false, error: "INVALID_SENDER_ID" }
  const resolvedSenderId: string | null = sender.name

  // 2. Prepare message (token substitution + strip undeliverable chars).
  let prepared: string
  try {
    prepared = prepareSmsMessage(message, shopTokens ?? NO_TOKENS)
  } catch {
    return { ok: false, error: "EMPTY_MESSAGE" }
  }
  if (!prepared || prepared.trim().length === 0) {
    return { ok: false, error: "EMPTY_MESSAGE" }
  }

  // 2b. Send policy — RECORD-ONLY in Phase 1 (spec §5.3): the would-be decision is stored
  //     on the send log; the send proceeds exactly as before.
  //     Started now but awaited only where the log inserts need it (capped at 1.5 s), so
  //     it overlaps the filter, phone validation and the debit.
  //     When enforced, the decision was already made once for the whole send: record that.
  const shadowPromise = enforced
    ? Promise.resolve({ mode: enforced.mode, shadow: enforced.shadow })
    : shadowPolicyWithin({ accountId, sender, recipientCount: recipients.length, message: prepared })

  // 3. Content filter (on the SAME text that will be billed + sent). Blocked → cost 0, audit row.
  const filterResult = filterSmsContent(prepared)
  const seg = calculateSegments(prepared).segments
  if (filterResult.blocked) {
    const { mode, shadow } = await shadowPromise
    await supabaseAdmin.from("sms_send_logs").insert({
      sms_account_id: accountId,
      message,
      recipients_count: recipients.length,
      segments: seg,
      credits_used: 0,
      credits_reserved: 0,
      status: "blocked",
      flagged: true,
      flag_reason: filterResult.reason ?? "blocked",
      mode,
      policy_shadow: shadow,
    })
    return { ok: false, error: "BLOCKED", reason: filterResult.reason }
  }

  // 4. Validate/normalize phones BEFORE debiting — bill only what we can actually queue.
  const validPhones: string[] = []
  let invalidSkipped = 0
  for (const raw of recipients) {
    const phone = normalizePhoneNumber(raw)
    if (phone) validPhones.push(phone)
    else invalidSkipped++
  }
  if (validPhones.length === 0) {
    return { ok: false, error: "NO_VALID_RECIPIENTS" }
  }

  const creditsNeeded = seg * validPhones.length

  // 5. Atomic gate + debit (reserve credits for the deliverable recipients only).
  const { data: debitData, error: rpcError } = await supabaseAdmin.rpc("debit_sms_for_send", {
    p_account_id: accountId,
    p_credits: creditsNeeded,
  })
  if (rpcError) {
    const msg = rpcError.message ?? ""
    if (msg.includes("NOT_ACTIVATED")) return { ok: false, error: "NOT_ACTIVATED" }
    if (msg.includes("SUSPENDED")) return { ok: false, error: "SUSPENDED" }
    if (msg.includes("INSUFFICIENT_CREDITS")) return { ok: false, error: "INSUFFICIENT_CREDITS" }
    throw rpcError
  }
  // Ledger row id of this debit (added by 20261012_sms_ledger_campaign_link; absent before it).
  const debitTxId: number | null =
    (Array.isArray(debitData) ? debitData[0]?.debit_tx_id : (debitData as { debit_tx_id?: number } | null)?.debit_tx_id) ?? null

  // 6. ENQUEUE (durable). Refund ONLY if the enqueue itself fails — at that point
  //    nothing was sent. Dispatch happens in step 7, AFTER this block, so a
  //    post-send hiccup can never trigger a wrongful refund of a delivered batch.
  let sendLogId = ""
  const inserted: { id: string; phone: string }[] = []
  let claimedAtMs = Date.now()
  try {
    const { mode, shadow } = await shadowPromise // never rejects (shadowPolicyWithin catches)
    const { data: logData, error: logError } = await supabaseAdmin
      .from("sms_send_logs")
      .insert({
        sms_account_id: accountId,
        message,
        sender_id: resolvedSenderId,
        recipients_count: validPhones.length,
        segments: seg,
        credits_used: 0, // settled by the drain via recompute_sms_send_result
        credits_reserved: creditsNeeded,
        // 'held'/'scheduled' are exempt from recompute_sms_send_result and their messages from the
        // drain claim.
        status: held ? "held" : scheduled ? "scheduled" : "queued",
        flagged: filterResult.flagged,
        flag_reason: filterResult.flagged ? (filterResult.reason ?? null) : null,
        mode,
        policy_shadow: shadow,
        ...extraLogCols,
      })
      .select("id")
      .single()
    if (logError || !logData) throw logError ?? new Error("Failed to insert sms_send_logs row")

    sendLogId = logData.id

    // Link the debit to this campaign so Credit History can show "Campaign #id". Best-effort:
    // credits are already taken, so a failed link must NEVER fail (or refund) the send.
    if (debitTxId != null) {
      try {
        const { error: linkErr } = await supabaseAdmin
          .from("sms_unit_transactions")
          .update({ send_log_id: sendLogId })
          .eq("id", debitTxId)
          .eq("sms_account_id", accountId)
        if (linkErr) console.error("[SMS-LEDGER] failed to link debit to send log:", linkErr.message)
      } catch (linkEx) {
        console.error("[SMS-LEDGER] failed to link debit to send log:", linkEx)
      }
    }
    const rows = validPhones.map((phone) => ({
      send_log_id: sendLogId,
      sms_account_id: accountId,
      phone,
      rendered_message: prepared,
      segments: seg,
      // Inserted pre-claimed so the cron drain (claims pending/failed only) cannot grab them
      // mid-dispatch and double-send. Released back to 'pending' after dispatch (step 7); if this
      // function dies first, the drain's stale-claim reaper returns them after 5 minutes.
      // HELD campaigns: plain 'pending', unclaimed — never dispatched here; the drain's claim
      // skips messages of held logs (migration 20261013) until an admin releases the campaign.
      // SCHEDULED campaigns: same — pending/unclaimed until the cron promotes the log to 'queued'.
      ...(deferred ? { status: "pending" } : { status: "claimed", claimed_at: new Date().toISOString() }),
      sender_id: resolvedSenderId,
    }))
    if (!deferred) claimedAtMs = Date.parse((rows[0] as { claimed_at: string }).claimed_at)
    for (let i = 0; i < rows.length; i += 500) {
      const { data: ins, error: msgError } = await supabaseAdmin
        .from("sms_messages")
        .insert(rows.slice(i, i + 500))
        .select("id, phone")
      if (msgError) throw msgError
      if (ins) inserted.push(...(ins as { id: string; phone: string }[]))
    }
  } catch (insertErr) {
    // Compensating refund — credits were reserved but nothing got queued.
    await supabaseAdmin
      .rpc("adjust_sms_units", {
        p_account_id: accountId,
        p_delta: creditsNeeded,
        p_reason: "campaign_refund",
        p_ref: `enqueue-rollback-${accountId}-${Date.now()}`,
      })
      .then(({ error }: { error: { message?: string } | null }) => {
        if (error) console.error("[SMS-SEND] enqueue rollback refund failed:", error.message)
      })
    console.error("[SMS-SEND] enqueue failed after debit (refunded):", insertErr)
    // Enforced path: the log row may already exist with no (or partial) messages. Close it
    // (refund already done above) so a later admin release/reject can never refund it again.
    // Conditional on its status so a concurrently-moved log is never overwritten.
    // A scheduled log is closed on every path too: otherwise the cron would later promote a log
    // whose credits were already refunded here. (Unscheduled record-only path left as before.)
    if ((enforced || scheduledIso !== null) && sendLogId) {
      // The message INSERT may have committed even though its response errored. Neutralise any such
      // rows BEFORE the log leaves held/scheduled (which is what keeps the drain off them), so the
      // drain can never send already-refunded messages for free. Nothing was dispatched yet, so
      // 'claimed' rows (allow path, pre-claimed) are covered too. Best-effort, never throws.
      try {
        const { error: msgErr } = await supabaseAdmin
          .from("sms_messages")
          .update({ status: "failed", attempts: 3, refunded: true, last_error: "enqueue_rolled_back" })
          .eq("send_log_id", sendLogId)
          .in("status", ["pending", "claimed"])
        if (msgErr) console.error("[SMS-SEND] could not neutralise orphan messages", sendLogId, msgErr.message)
      } catch (e) {
        console.error("[SMS-SEND] could not neutralise orphan messages", sendLogId, e)
      }
      try {
        const { error: orphanErr } = await supabaseAdmin
          .from("sms_send_logs")
          .update({ status: "failed", credits_reserved: 0 })
          .eq("id", sendLogId)
          .in("status", ["queued", "held", "scheduled"])
        if (orphanErr) console.error("[SMS-SEND] could not close orphan send log", sendLogId, orphanErr.message)
      } catch (e) {
        console.error("[SMS-SEND] could not close orphan send log", sendLogId, e)
      }
    }
    return { ok: false, error: "ENQUEUE_FAILED" }
  }

  // Logged + messages stored. Never let the callback affect a paid send.
  if (onLogged) {
    try {
      await onLogged(sendLogId)
    } catch (e) {
      console.error("[SMS-SEND] onLogged callback failed (ignored):", e)
    }
  }

  // Held for review: credits reserved and messages stored; no dispatch, release or recompute.
  if (held) {
    return {
      ok: true,
      sendLogId,
      total: validPhones.length,
      segments: seg,
      creditsReserved: creditsNeeded,
      invalidSkipped,
      held: true,
    }
  }

  // Scheduled: credits reserved and messages stored; the sms-scheduled cron dispatches it when due.
  if (scheduled) {
    return {
      ok: true,
      sendLogId,
      total: validPhones.length,
      segments: seg,
      creditsReserved: creditsNeeded,
      invalidSkipped,
      scheduled: true,
      scheduledFor: scheduledIso!,
    }
  }

  // 7. INSTANT dispatch through provider routing (Hubtel batches when primary). Deliberately
  //    OUTSIDE the refund block: rows are durable, so a failure here must NEVER refund a batch
  //    a provider already accepted. Rows not placed stay 'pending' for the cron drain.
  //    Rows are marked sent PER CHUNK (onChunkSent) so a timeout mid-campaign leaves only
  //    truly unsent rows pending.
  // Placed at the provider but neither marked via the RPC nor via the plain-update fallback:
  // these must NOT be released to pending (the drain would re-send them); they wait for the reaper.
  const placedUnmarked = new Set<string>()
  try {
    const mark = async (provider: string, rows: SentRow[], info: { unconfirmed: boolean }) => {
      if (rows.length === 0) return
      // mark_sms_messages_sent is idempotent: retry transient errors (~250 ms, ~1 s) before giving up.
      let error: { message?: string } | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 250 : 1000))
        ;({ error } = await supabaseAdmin.rpc("mark_sms_messages_sent", { p_provider: provider, p_rows: rows }))
        if (!error) break
      }
      if (error) {
        console.error(`[SMS-SEND] mark-sent RPC (${provider}) failed after retries; trying plain update:`, error.message)
        // The provider already accepted these rows, so releasing them would double-send. Fall back
        // to a plain status update (no provider ids, so the DLR poller cannot confirm them).
        const ids = rows.map((r) => r.id)
        const { error: fbErr } = await supabaseAdmin
          .from("sms_messages")
          .update({ status: "sent", provider, processed_at: new Date().toISOString() })
          .in("id", ids)
          .eq("status", "claimed")
        if (fbErr) {
          // Keep them claimed (excluded from the release) so the 5-min reaper, not an immediate
          // release, returns them. Never refund here.
          console.error(`[SMS-SEND] mark-sent fallback (${provider}) failed; rows held for the reaper:`, fbErr.message)
          for (const id of ids) placedUnmarked.add(id)
          return
        }
      }
      // Hubtel "unknown" outcome: placed without ids. Tag so admins can count them (a spike
      // means a Hubtel outage); the DLR poller's 72 h close refunds any that never deliver.
      if (provider === "hubtel" && info.unconfirmed) {
        const { error: tagErr } = await supabaseAdmin
          .from("sms_messages")
          .update({ last_error: "hubtel_unconfirmed" })
          .in("id", rows.map((r) => r.id))
        if (tagErr) console.error("[SMS-SEND] unconfirmed tagging failed:", tagErr.message)
      }
    }
    const result = await dispatchCampaign(
      inserted.map((m) => ({ id: m.id, phone: m.phone, message: prepared })),
      resolvedSenderId,
      mark,
      // Stop starting chunks 1 min before send-drain's STALE_CLAIM_MS (5 min) reaper could
      // hand still-claimed rows back to the drain mid-dispatch.
      claimedAtMs + 4 * 60_000
    )
    const firstBatch = result.sent.find((r) => r.bid)?.bid
    if (firstBatch) {
      await supabaseAdmin.from("sms_send_logs").update({ provider_batch_id: firstBatch, provider: "hubtel" }).eq("id", sendLogId)
    }
  } catch (e) {
    console.error("[SMS-SEND] dispatch failed (rows stay pending for the drain):", e)
  } finally {
    // Release rows dispatch did not place (still 'claimed') so the drain can pick them up.
    // Placed rows were flipped to 'sent' by mark_sms_messages_sent and are untouched.
    try {
      let rel = supabaseAdmin
        .from("sms_messages")
        .update({ status: "pending", claimed_at: null })
        .eq("send_log_id", sendLogId)
        .eq("status", "claimed")
      if (placedUnmarked.size > 0) rel = rel.not("id", "in", `(${[...placedUnmarked].join(",")})`)
      const { error: relErr } = await rel
      if (relErr) console.error("[SMS-SEND] release of unplaced rows failed (stale-claim reaper will recover):", relErr.message)
    } catch (e) {
      console.error("[SMS-SEND] release of unplaced rows threw (stale-claim reaper will recover):", e)
    }
  }
  // Roll the per-recipient outcomes up into the parent status so the UI reflects it
  // immediately. Non-fatal if it hiccups.
  try {
    const { error: recErr } = await supabaseAdmin.rpc("recompute_sms_send_result", {
      p_send_log_id: sendLogId,
      max_attempts: 3,
    })
    if (recErr) console.warn("[SMS-SEND] recompute failed:", recErr)
  } catch { /* non-fatal */ }

  return {
    ok: true,
    sendLogId,
    total: validPhones.length,
    segments: seg,
    creditsReserved: creditsNeeded,
    invalidSkipped,
  }
}

export interface BatchedSendResult {
  ok: true
  batches: number          // how many batches actually queued
  totalQueued: number      // sum of recipients queued across batches
  segments: number         // per-recipient segments (same for every batch)
  creditsReserved: number  // sum of credits reserved across batches
  invalidSkipped: number
  partial: boolean         // true if it stopped before sending every batch
  stoppedReason?: string   // the error that stopped further batches (e.g. credits)
  held: boolean            // true when the send was held for admin review (debited, not dispatched)
  scheduled: boolean       // true when the send was scheduled (debited, dispatched later by the cron)
  scheduledFor: string | null // the ISO instant every scheduled batch is due (null when not scheduled)
  sendLogId: string | null // the first batch's send log (a send of >500 has one log per batch)
}

/**
 * Auto-batch a large send: split into SMS_BATCH_SIZE (=500) chunks and enqueue
 * each sequentially via enqueueSend. Sequential (not parallel) so a mid-run
 * credit shortfall stops cleanly — earlier batches are already queued, later
 * ones simply aren't sent, and we report that as a partial success so the user
 * can top up and resend the rest. Each enqueueSend reserves/refunds its OWN
 * credits atomically, so there is no cross-batch double-charge.
 */
/**
 * Pure sequential-batch orchestrator (sendChunk injected so it's testable
 * without the DB). Splits `recipients` into `batchSize` chunks and sends each in
 * order. Rules:
 *  - empty / over-ceiling → hard error before any send.
 *  - a chunk that returns NO_VALID_RECIPIENTS is SKIPPED (not a stop) — a block of
 *    malformed numbers shouldn't halt the campaign; if EVERY chunk is invalid the
 *    whole thing returns NO_VALID_RECIPIENTS.
 *  - any other returned error / a THROW: hard error if nothing's sent yet (safe
 *    retry — nothing charged), else a partial success reporting what DID go out.
 */
export async function runSequentialBatches(
  recipients: string[],
  sendChunk: (chunk: string[]) => Promise<EnqueueSendResult | EnqueueSendError>,
  opts: { batchSize: number; maxTotal: number }
): Promise<BatchedSendResult | EnqueueSendError> {
  if (recipients.length === 0) return { ok: false, error: "NO_VALID_RECIPIENTS" }
  if (recipients.length > opts.maxTotal) return { ok: false, error: "TOO_MANY_RECIPIENTS" }

  const chunks: string[][] = []
  for (let i = 0; i < recipients.length; i += opts.batchSize) {
    chunks.push(recipients.slice(i, i + opts.batchSize))
  }

  let batches = 0
  let totalQueued = 0
  let creditsReserved = 0
  let segments = 0
  let invalidSkipped = 0
  let held = false
  let scheduledFor: string | null = null
  let sendLogId: string | null = null
  const partial = (stoppedReason: string): BatchedSendResult =>
    ({ ok: true, batches, totalQueued, segments, creditsReserved, invalidSkipped, partial: true, stoppedReason, held, scheduled: scheduledFor !== null, scheduledFor, sendLogId })

  for (const chunk of chunks) {
    let r: EnqueueSendResult | EnqueueSendError
    try {
      r = await sendChunk(chunk)
    } catch (e) {
      // A THROW means THIS batch charged nothing (failure before/at the rolled-back
      // debit). If nothing's gone out yet, rethrow for a safe retry; otherwise report
      // the earlier delivered+charged batches as a partial.
      if (batches === 0) throw e
      return partial("SEND_ERROR")
    }
    if (!r.ok) {
      if (r.error === "NO_VALID_RECIPIENTS") continue // skip an all-invalid chunk
      if (batches === 0) return r                      // hard gate, nothing sent
      return partial(r.error)                          // e.g. credits depleted mid-run
    }
    batches++
    totalQueued += r.total
    creditsReserved += r.creditsReserved
    segments = r.segments
    invalidSkipped += r.invalidSkipped
    if (r.held) held = true
    if (r.scheduled && r.scheduledFor) scheduledFor = r.scheduledFor
    if (sendLogId === null) sendLogId = r.sendLogId
  }

  if (batches === 0) return { ok: false, error: "NO_VALID_RECIPIENTS" } // every chunk invalid
  return { ok: true, batches, totalQueued, segments, creditsReserved, invalidSkipped, partial: false, held, scheduled: scheduledFor !== null, scheduledFor, sendLogId }
}

const BATCH_OPTS = { batchSize: SMS_BATCH_SIZE, maxTotal: SMS_MAX_TOTAL }

export async function enqueueSendBatched(
  userId: string,
  accountId: string,
  message: string,
  recipients: string[],
  shopTokens?: ShopTokens,
  senderId?: string,
  opts?: EnqueueSendOptions
): Promise<BatchedSendResult | EnqueueSendError> {
  // Record-only (sms_policy_enforced = false, the default): exactly the pre-enforcement path.
  if (!(await isPolicyEnforced())) {
    return runSequentialBatches(
      recipients,
      // opts is forwarded only when given, so the unscheduled call is exactly as before.
      (chunk) => (opts
        ? enqueueSend(userId, accountId, message, chunk, shopTokens, senderId, undefined, undefined, opts)
        : enqueueSend(userId, accountId, message, chunk, shopTokens, senderId)),
      BATCH_OPTS
    )
  }
  return enforcedSendBatched(userId, accountId, message, recipients, shopTokens, senderId, opts)
}

/**
 * Enforced send: the policy is evaluated ONCE on the full list, BEFORE batching or any debit.
 *  - reject / unavailable → POLICY_REJECTED (+ code, customer reason). Nothing written.
 *  - block → one 'blocked' log for the whole send + fraud flags recorded. Nothing debited.
 *  - hold  → every batch debited and stored 'held' (messages un-dispatched). held:true.
 *  - allow → the normal batched send; logs record the enforced decision.
 */
async function enforcedSendBatched(
  userId: string,
  accountId: string,
  message: string,
  recipients: string[],
  shopTokens?: ShopTokens,
  senderId?: string,
  opts?: EnqueueSendOptions
): Promise<BatchedSendResult | EnqueueSendError> {
  // Same pre-checks the record-only path applies (runSequentialBatches + enqueueSend), before
  // the evaluation so a cheap refusal never costs a policy read.
  if (recipients.length === 0) return { ok: false, error: "NO_VALID_RECIPIENTS" }
  if (recipients.length > SMS_MAX_TOTAL) return { ok: false, error: "TOO_MANY_RECIPIENTS" }
  if (!(await isSmsEnabled())) return { ok: false, error: "SMS_DISABLED" }
  const sender = await resolveCampaignSender(accountId, senderId)
  if (!sender) return { ok: false, error: "INVALID_SENDER_ID" }
  let prepared: string
  try {
    prepared = prepareSmsMessage(message, shopTokens ?? NO_TOKENS)
  } catch {
    return { ok: false, error: "EMPTY_MESSAGE" }
  }
  if (!prepared || prepared.trim().length === 0) return { ok: false, error: "EMPTY_MESSAGE" }

  // Per-account lease: taken BEFORE the usage/policy read and released as soon as this send's
  // LAST log row (+ messages) exists — before that chunk's provider dispatch — so a parallel
  // send can't read the same usage and slip past the caps, yet isn't blocked by dispatch time.
  const lock = await trySendLock(accountId)
  if (lock.status === "error") {
    return { ok: false, error: "POLICY_REJECTED", code: "POLICY_UNAVAILABLE", reason: POLICY_UNAVAILABLE_REASON }
  }
  if (lock.status === "busy") return { ok: false, error: "SEND_IN_PROGRESS", reason: SEND_IN_PROGRESS_MESSAGE }
  const token = lock.token
  let released = false
  // Exactly once (early from the last chunk, else in the finally). Owner-scoped in SQL, so even a
  // late release after the lease expired and was re-taken by another send is a no-op.
  const release = async () => {
    if (released) return
    released = true
    await releaseSendLock(accountId, token)
  }
  try {
    return await enforcedSendLocked(userId, accountId, message, recipients, prepared, sender, release, shopTokens, senderId, opts)
  } finally {
    await release()
  }
}

async function enforcedSendLocked(
  userId: string,
  accountId: string,
  message: string,
  recipients: string[],
  prepared: string,
  sender: PolicySender,
  release: () => Promise<void>,
  shopTokens?: ShopTokens,
  senderId?: string,
  opts?: EnqueueSendOptions
): Promise<BatchedSendResult | EnqueueSendError> {
  const outcome = await evaluateForEnforcement({ accountId, sender, recipientCount: recipients.length, message: prepared })

  if (outcome.kind === "reject") {
    return { ok: false, error: "POLICY_REJECTED", code: outcome.code, reason: outcome.reason }
  }

  if (outcome.kind === "block") {
    let blockedLogId: string | null = null
    try {
      const { data, error } = await supabaseAdmin
        .from("sms_send_logs")
        .insert({
          sms_account_id: accountId,
          message,
          sender_id: sender.name,
          recipients_count: recipients.length,
          segments: calculateSegments(prepared).segments,
          credits_used: 0,
          credits_reserved: 0,
          status: "blocked",
          // Not flagged: the sms_flags row(s) recorded below are the moderation record; a flagged
          // log too would show every enforced block twice in the admin Flagged tab/overview.
          flagged: false,
          flag_reason: outcome.fraudFlags[0]?.reason ?? outcome.code,
          mode: outcome.mode,
          policy_shadow: outcome.shadow,
        })
        .select("id")
        .single()
      if (error) console.error("[SMS-ENFORCE] blocked log insert failed:", error.message)
      blockedLogId = (data as { id: string } | null)?.id ?? null
    } catch (e) {
      console.error("[SMS-ENFORCE] blocked log insert threw:", e)
    }
    await recordFlags({ accountId, sendLogId: blockedLogId, flags: outcome.fraudFlags, thresholds: outcome.thresholds })
    // `code` marks this reason as policy-written customer text (see customerBlockedReason).
    return { ok: false, error: "BLOCKED", code: outcome.code, reason: outcome.reason }
  }

  const policy: ChunkPolicy = { decision: outcome.kind, mode: outcome.mode, shadow: outcome.shadow }

  // Flags the policy raised on an allowed/held send (business info flags, e.g. flagged keywords)
  // count toward the review-hold threshold. Attached to the FIRST log; recorded once, best-effort
  // (recordFlags never throws) so a paid send is never failed by it. No log → nothing recorded.
  let firstLogId: string | null = null
  let flagsRecorded = false
  const recordFlagsOnce = async () => {
    if (flagsRecorded || !firstLogId || outcome.shadow.flags.length === 0) return
    flagsRecorded = true
    await recordFlags({ accountId, sendLogId: firstLogId, flags: outcome.shadow.flags, thresholds: outcome.thresholds })
  }

  // Intermediate chunks keep the lease (their successors' logs don't exist yet); the LAST chunk
  // releases it right after its log + messages are inserted, before its dispatch.
  const totalChunks = Math.ceil(recipients.length / SMS_BATCH_SIZE)
  let chunkNo = 0
  const result = await runSequentialBatches(
    recipients,
    (chunk) => {
      const isLast = ++chunkNo === totalChunks
      return enqueueSend(userId, accountId, message, chunk, shopTokens, senderId, policy, async (logId) => {
        if (firstLogId === null) firstLogId = logId
        if (isLast) {
          await recordFlagsOnce()
          await release()
        }
      }, opts)
    },
    BATCH_OPTS
  )
  // The last chunk may never have been logged (e.g. credits ran out mid-run): record now.
  await recordFlagsOnce()
  return result
}
