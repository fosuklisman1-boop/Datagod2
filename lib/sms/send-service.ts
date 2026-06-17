import { createClient } from "@supabase/supabase-js"
import { prepareSmsMessage, type ShopTokens } from "./prepare"
import { filterSmsContent } from "./content-filter"
import { calculateSegments } from "./segments"
import { sendSMSBulkViaMoolre } from "@/lib/sms-service"

// One Moolre bulk call carries up to this many recipients; 500-recipient sends
// fan out into a few sequential calls, all within the send request.
const BULK_CHUNK = 100

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

  // 1b. Resolve the chosen sender ID (before any debit). It must be one of THIS
  //     account's own ACTIVE sender IDs (spec §3: "campaigns may only select an
  //     active sender ID"). Omitted → null → the platform default at send time.
  let resolvedSenderId: string | null = null
  if (senderId && senderId.trim()) {
    const sid = senderId.trim().toUpperCase()
    const { data: active } = await supabaseAdmin
      .from("sms_sender_ids")
      .select("sender_id")
      .eq("sms_account_id", accountId)
      .eq("sender_id", sid)
      .eq("local_status", "active")
      .maybeSingle()
    if (!active) return { ok: false, error: "INVALID_SENDER_ID" }
    resolvedSenderId = sid
  }

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

  // 3. Content filter (on the SAME text that will be billed + sent). Blocked → cost 0, audit row.
  const filterResult = filterSmsContent(prepared)
  const seg = calculateSegments(prepared).segments
  if (filterResult.blocked) {
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
      status: "pending",
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

  // 7. INSTANT dispatch via the Moolre BULK API — one (chunked) call sends every
  //    recipient now, so the batch shows 'sent' before the response returns. This is
  //    deliberately OUTSIDE the refund block: the rows are durable, so a failure here
  //    must NEVER refund a batch Moolre already accepted. Rows the bulk call can't
  //    place stay 'pending' for the cron drain (retry + refund-on-terminal-failure).
  const sentIds: string[] = []
  for (let i = 0; i < inserted.length; i += BULK_CHUNK) {
    const chunk = inserted.slice(i, i + BULK_CHUNK)
    const items = chunk.map((m) => ({ recipient: m.phone, message: prepared, ref: m.id }))
    let res: { ok: boolean }
    try {
      res = await sendSMSBulkViaMoolre(items, resolvedSenderId ?? undefined)
    } catch {
      res = { ok: false }
    }
    if (res.ok) sentIds.push(...chunk.map((m) => m.id))
  }
  if (sentIds.length > 0) {
    const { error: markErr } = await supabaseAdmin
      .from("sms_messages")
      .update({ status: "sent", provider: "moolre", processed_at: new Date().toISOString() })
      .in("id", sentIds)
    // If this write fails the rows stay 'pending' and the cron may re-send them
    // (at-least-once). We log loudly but NEVER refund here — Moolre already accepted
    // them, so a refund would hand back credits for delivered messages.
    if (markErr) console.error("[SMS-SEND] mark-sent failed (cron will reconcile):", markErr.message)
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
