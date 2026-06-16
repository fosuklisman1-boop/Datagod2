import { createClient } from "@supabase/supabase-js"
import { sendSMS } from "@/lib/sms-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// How many send attempts before a row is treated as terminally failed.
// Must match the default in claim_sms_messages / recompute_sms_send_result.
export const MAX_ATTEMPTS = 3

// A claimed row whose worker died never reaches 'sent'/'failed'. After 5 min
// we hand it back to the queue so it is not stranded forever.
const STALE_CLAIM_INTERVAL = "5 minutes"

interface SmsMessageRow {
  id: string
  send_log_id: string
  sms_account_id: string
  phone: string
  rendered_message: string
  segments: number
  attempts: number
}

export interface DrainResult {
  claimed: number
  sent: number
  failed: number
  refunded: number
}

/**
 * Claim and process a batch of pending sms_messages rows.
 * - Reaps stale 'claimed' rows back to 'pending' first.
 * - Claims via the claim_sms_messages RPC (SKIP LOCKED — safe for concurrent runs).
 * - On terminal failure (attempts >= MAX_ATTEMPTS) refunds credits via adjust_sms_units.
 * - Calls recompute_sms_send_result for each touched send_log_id.
 */
export async function drainSmsMessages(opts: { limit?: number } = {}): Promise<DrainResult> {
  const limit = opts.limit ?? 100

  // (a) Reap stale claimed rows back to pending
  await supabaseAdmin
    .from("sms_messages")
    .update({ status: "pending" })
    .eq("status", "claimed")
    .lt("claimed_at", new Date(Date.now() - 5 * 60 * 1000).toISOString())

  // (b) Claim a batch
  const { data: claimed, error: claimError } = await supabaseAdmin.rpc("claim_sms_messages", {
    p_limit: limit,
    p_max_attempts: MAX_ATTEMPTS,
  })

  if (claimError) throw claimError
  const rows = (claimed ?? []) as SmsMessageRow[]
  if (rows.length === 0) {
    return { claimed: 0, sent: 0, failed: 0, refunded: 0 }
  }

  let sent = 0
  let failed = 0
  let refunded = 0
  const touchedLogIds = new Set<string>()

  // (c) Process each row — never abort the batch on a single row error
  for (const row of rows) {
    touchedLogIds.add(row.send_log_id)
    try {
      const r = await sendSMS({
        phone: row.phone,
        message: row.rendered_message,
        type: "shop_sms",
        reference: row.id,
      })

      if (r.success) {
        await supabaseAdmin
          .from("sms_messages")
          .update({
            status: "sent",
            processed_at: new Date().toISOString(),
            ref: r.ref ?? r.messageId ?? null,
            provider: r.provider ?? null,
          })
          .eq("id", row.id)
        sent++
      } else {
        const isTerminal = row.attempts >= MAX_ATTEMPTS
        await supabaseAdmin
          .from("sms_messages")
          .update({
            status: "failed",
            last_error: r.error ?? "send failed",
            processed_at: new Date().toISOString(),
          })
          .eq("id", row.id)
        failed++

        if (isTerminal) {
          // Refund the credits reserved for this message
          const { error: refundError } = await supabaseAdmin.rpc("adjust_sms_units", {
            p_account_id: row.sms_account_id,
            p_delta: row.segments,
            p_reason: "campaign_refund",
            p_ref: row.id,
          })
          if (refundError) {
            // Best-effort: log to sms_refund_failures so ops can investigate
            console.error(`[SMS-DRAIN] Refund RPC failed for message ${row.id}:`, refundError.message)
            await supabaseAdmin
              .from("sms_refund_failures")
              .insert({
                sms_account_id: row.sms_account_id,
                credits: row.segments,
                reason: `adjust_sms_units failed: ${refundError.message}`,
                sms_message_id: row.id,
              })
              .then(({ error }) => {
                if (error) console.error("[SMS-DRAIN] sms_refund_failures insert failed:", error.message)
              })
          } else {
            refunded++
          }
        }
      }
    } catch (e: any) {
      // Unexpected error on a single row — mark failed, never abort batch
      const isTerminal = row.attempts >= MAX_ATTEMPTS
      await supabaseAdmin
        .from("sms_messages")
        .update({
          status: "failed",
          last_error: String(e?.message ?? e),
          processed_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .then(({ error }) => {
          if (error) console.error("[SMS-DRAIN] status update failed:", error.message)
        })
      failed++

      if (isTerminal) {
        const { error: refundError } = await supabaseAdmin.rpc("adjust_sms_units", {
          p_account_id: row.sms_account_id,
          p_delta: row.segments,
          p_reason: "campaign_refund",
          p_ref: row.id,
        })
        if (refundError) {
          console.error(`[SMS-DRAIN] Refund RPC failed (catch path) for message ${row.id}:`, refundError.message)
          await supabaseAdmin.from("sms_refund_failures").insert({
            sms_account_id: row.sms_account_id,
            credits: row.segments,
            reason: `adjust_sms_units failed: ${refundError.message}`,
            sms_message_id: row.id,
          }).then(({ error }) => {
            if (error) console.error("[SMS-DRAIN] sms_refund_failures insert failed:", error.message)
          })
        } else {
          refunded++
        }
      }
    }
  }

  // (d) Recompute send_log status for each touched log
  for (const logId of touchedLogIds) {
    await supabaseAdmin
      .rpc("recompute_sms_send_result", {
        p_send_log_id: logId,
        p_max_attempts: MAX_ATTEMPTS,
      })
      .then(({ error }) => {
        if (error) console.warn(`[SMS-DRAIN] recompute_sms_send_result failed for ${logId}:`, error.message)
      })
  }

  console.log(`[SMS-DRAIN] claimed=${rows.length} sent=${sent} failed=${failed} refunded=${refunded}`)
  return { claimed: rows.length, sent, failed, refunded }
}
