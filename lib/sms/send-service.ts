import { createClient } from "@supabase/supabase-js"
import { prepareSmsMessage, type ShopTokens } from "./prepare"
import { filterSmsContent } from "./content-filter"
import { calculateSegments } from "./segments"
import { resolveCampaignSender, shadowPolicyWithin } from "./policy-context"
import { dispatchCampaign, type SentRow } from "./campaign-dispatch"

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

export interface EnqueueSendResult {
  ok: true
  sendLogId: string
  total: number
  segments: number
  creditsReserved: number
  invalidSkipped: number
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
  reason?: string
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
  senderId?: string
): Promise<EnqueueSendResult | EnqueueSendError> {
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
    prepared = prepareSmsMessage(
      message,
      shopTokens ?? { shop_name: "", shop_link: "", shop_phone: "", shop_whatsapp: "" }
    )
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
  const shadowPromise = shadowPolicyWithin({ accountId, sender, recipientCount: recipients.length, message: prepared })

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
  const { error: rpcError } = await supabaseAdmin.rpc("debit_sms_for_send", {
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

  // 6. ENQUEUE (durable). Refund ONLY if the enqueue itself fails — at that point
  //    nothing was sent. Dispatch happens in step 7, AFTER this block, so a
  //    post-send hiccup can never trigger a wrongful refund of a delivered batch.
  let sendLogId = ""
  const inserted: { id: string; phone: string }[] = []
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
        status: "queued",
        flagged: filterResult.flagged,
        flag_reason: filterResult.flagged ? (filterResult.reason ?? null) : null,
        mode,
        policy_shadow: shadow,
      })
      .select("id")
      .single()
    if (logError || !logData) throw logError ?? new Error("Failed to insert sms_send_logs row")

    sendLogId = logData.id
    const rows = validPhones.map((phone) => ({
      send_log_id: sendLogId,
      sms_account_id: accountId,
      phone,
      rendered_message: prepared,
      segments: seg,
      // Inserted pre-claimed so the cron drain (claims pending/failed only) cannot grab them
      // mid-dispatch and double-send. Released back to 'pending' after dispatch (step 7); if this
      // function dies first, the drain's stale-claim reaper returns them after 5 minutes.
      status: "claimed",
      claimed_at: new Date().toISOString(),
      sender_id: resolvedSenderId,
    }))
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
    return { ok: false, error: "ENQUEUE_FAILED" }
  }

  // 7. INSTANT dispatch through provider routing (Hubtel batches when primary). Deliberately
  //    OUTSIDE the refund block: rows are durable, so a failure here must NEVER refund a batch
  //    a provider already accepted. Rows not placed stay 'pending' for the cron drain.
  //    Rows are marked sent PER CHUNK (onChunkSent) so a timeout mid-campaign leaves only
  //    truly unsent rows pending.
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
        // Rows are released back to 'pending' and the drain may re-send them (at-least-once). Never refund here.
        console.error(`[SMS-SEND] mark-sent (${provider}) failed (cron will reconcile):`, error.message)
        return
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
      mark
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
      const { error: relErr } = await supabaseAdmin
        .from("sms_messages")
        .update({ status: "pending", claimed_at: null })
        .eq("send_log_id", sendLogId)
        .eq("status", "claimed")
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
  const partial = (stoppedReason: string): BatchedSendResult =>
    ({ ok: true, batches, totalQueued, segments, creditsReserved, invalidSkipped, partial: true, stoppedReason })

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
  }

  if (batches === 0) return { ok: false, error: "NO_VALID_RECIPIENTS" } // every chunk invalid
  return { ok: true, batches, totalQueued, segments, creditsReserved, invalidSkipped, partial: false }
}

export async function enqueueSendBatched(
  userId: string,
  accountId: string,
  message: string,
  recipients: string[],
  shopTokens?: ShopTokens,
  senderId?: string
): Promise<BatchedSendResult | EnqueueSendError> {
  return runSequentialBatches(
    recipients,
    (chunk) => enqueueSend(userId, accountId, message, chunk, shopTokens, senderId),
    { batchSize: SMS_BATCH_SIZE, maxTotal: SMS_MAX_TOTAL }
  )
}
