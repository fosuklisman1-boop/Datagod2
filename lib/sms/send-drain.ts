import { createClient } from "@supabase/supabase-js"
import { sendSMS } from "@/lib/sms-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// How many send attempts before a row is treated as terminally failed.
// Must match the default in claim_sms_messages / recompute_sms_send_result (migration 0067).
export const MAX_ATTEMPTS = 3

// A claimed row whose worker died never reaches 'sent'/'failed'. After this window we hand it
// back to the queue so it is not stranded forever. SEND_TIMEOUT must be well under this so a
// worker can never outlive its claim (else a reaped row could be processed twice).
const STALE_CLAIM_MS = 5 * 60 * 1000
const SEND_TIMEOUT_MS = 30_000

interface SmsMessageRow {
  id: string
  send_log_id: string
  sms_account_id: string
  phone: string
  rendered_message: string
  segments: number
  attempts: number
  sender_id: string | null
}

export interface DrainResult {
  claimed: number
  sent: number
  failed: number
  refunded: number
}

/** Refund a terminally-failed message's reserved credits via the shared exactly-once RPC
 *  (ref = message id, also used by the DLR poller). Returns true only when THIS call refunded;
 *  an already-refunded message returns false so it is not counted twice. */
async function refundMessage(row: SmsMessageRow): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("refund_sms_message", { p_message_id: row.id })
  if (!error) return data === true
  console.error(`[SMS-DRAIN] Refund failed for message ${row.id}:`, error.message)
  await supabaseAdmin
    .from("sms_refund_failures")
    .insert({
      sms_account_id: row.sms_account_id,
      credits: row.segments,
      reason: `refund_sms_message failed: ${error.message}`,
    })
    .then(({ error: e }) => {
      if (e) console.error("[SMS-DRAIN] sms_refund_failures insert failed:", e.message)
    })
  return false
}

/** Send one message with a hard timeout, clearing the timer so it never leaks / rejects late. */
async function sendWithTimeout(row: SmsMessageRow) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      sendSMS({ phone: row.phone, message: row.rendered_message, type: "shop_sms", reference: row.id, senderId: row.sender_id ?? undefined }),
      new Promise<{ success: false; error: string }>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`send timeout after ${SEND_TIMEOUT_MS}ms`)), SEND_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function markFailed(row: SmsMessageRow, errMsg: string): Promise<void> {
  await supabaseAdmin
    .from("sms_messages")
    .update({ status: "failed", last_error: errMsg, processed_at: new Date().toISOString() })
    .eq("id", row.id)
    .then(({ error }) => {
      if (error) console.error("[SMS-DRAIN] status update failed:", error.message)
    })
}

/**
 * Claim and process a batch of pending sms_messages rows (mirrors lib/broadcast-drain.ts).
 * - Reaps stale 'claimed' rows back to 'pending' first (attempts NOT reset → cap preserved).
 * - Claims via claim_sms_messages (FOR UPDATE SKIP LOCKED — safe for concurrent drains).
 * - Each row is sent with a hard timeout; a single row error never aborts the batch.
 * - On terminal failure (attempts >= MAX_ATTEMPTS) refunds the row's credits (idempotently).
 * - Recomputes the parent sms_send_logs status for every touched send_log.
 */
export async function drainSmsMessages(opts: { limit?: number } = {}): Promise<DrainResult> {
  const limit = opts.limit ?? 100

  // (a) Reap stale claimed rows back to pending.
  await supabaseAdmin
    .from("sms_messages")
    .update({ status: "pending" })
    .eq("status", "claimed")
    .lt("claimed_at", new Date(Date.now() - STALE_CLAIM_MS).toISOString())

  // (b) Claim a batch. Arg names MUST match claim_sms_messages(lim, max_attempts).
  const { data: claimed, error: claimError } = await supabaseAdmin.rpc("claim_sms_messages", {
    lim: limit,
    max_attempts: MAX_ATTEMPTS,
  })
  if (claimError) throw claimError
  const rows = (claimed ?? []) as SmsMessageRow[]
  if (rows.length === 0) return { claimed: 0, sent: 0, failed: 0, refunded: 0 }

  let sent = 0
  let failed = 0
  let refunded = 0
  const touchedLogIds = new Set<string>()

  // (c) Process each row — never abort the batch on a single row error.
  for (const row of rows) {
    touchedLogIds.add(row.send_log_id)
    const isTerminal = row.attempts >= MAX_ATTEMPTS
    try {
      const r = await sendWithTimeout(row)

      if (r.success) {
        await supabaseAdmin
          .from("sms_messages")
          .update({
            status: "sent",
            processed_at: new Date().toISOString(),
            ref: r.ref ?? r.messageId ?? null,
            provider: r.provider ?? null,
            provider_message_id: r.provider === "hubtel" ? r.messageId ?? null : null,
          })
          .eq("id", row.id)
        sent++
      } else {
        await markFailed(row, r.error ?? "send failed")
        failed++
        if (isTerminal && (await refundMessage(row))) refunded++
      }
    } catch (e: any) {
      await markFailed(row, String(e?.message ?? e))
      failed++
      if (isTerminal && (await refundMessage(row))) refunded++
    }
  }

  // (d) Recompute parent status for each touched log. Arg name MUST match
  // recompute_sms_send_result(p_send_log_id, max_attempts).
  for (const logId of touchedLogIds) {
    await supabaseAdmin
      .rpc("recompute_sms_send_result", { p_send_log_id: logId, max_attempts: MAX_ATTEMPTS })
      .then(({ error }) => {
        if (error) console.warn(`[SMS-DRAIN] recompute_sms_send_result failed for ${logId}:`, error.message)
      })
  }

  console.log(`[SMS-DRAIN] claimed=${rows.length} sent=${sent} failed=${failed} refunded=${refunded}`)
  return { claimed: rows.length, sent, failed, refunded }
}
