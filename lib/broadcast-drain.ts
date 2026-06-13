import { SupabaseClient } from "@supabase/supabase-js"
import { sendSMS } from "@/lib/sms-service"
import { sendEmail, EmailTemplates } from "@/lib/email-service"
import { sendPushToUser } from "@/lib/push-service"
import { sendWhatsAppText, sendWhatsAppTemplate } from "@/lib/whatsapp-bot/send"

// How many times a single recipient may be (re)attempted before it is treated
// as terminally failed. Must match the default in claim_broadcast_recipients /
// recompute_broadcast_results so the SQL and the JS agree on what "done" means.
export const MAX_ATTEMPTS = 3

// Recipients processed per drain invocation, across all in-flight broadcasts.
// Each recipient may fan out to up to 4 channels; we sub-batch internally with a
// small delay to stay friendly to the SMS/email providers while comfortably
// finishing inside the function timeout.
const MAX_RECIPIENTS_PER_RUN = 30
const CONCURRENCY = 5
const SUB_BATCH_DELAY_MS = 1000

// A claimed row whose worker died never gets to 'sent'/'failed'. After this long
// we hand it back to the queue so it isn't stranded.
const STALE_CLAIM_MS = 5 * 60 * 1000

type ChannelOutcome = "sent" | "failed" | "skipped"

interface RecipientRow {
  id: string
  broadcast_id: string
  user_id: string | null
  email: string | null
  phone: string | null
  name: string | null
  attempts: number
  channel_status: Record<string, ChannelOutcome>
}

interface BroadcastRow {
  id: string
  channels: string[]
  subject: string | null
  message: string
}

/**
 * Resolve the full recipient list for a broadcast and persist it as pending
 * rows. Called once at init. For role-based targets the list is resolved
 * server-side (authoritative); for specific users the caller passes the list
 * since only the client knows which ones were picked.
 */
export async function enqueueRecipients(
  supabase: SupabaseClient,
  broadcastId: string,
  opts: {
    targetType: "roles" | "specific"
    roles?: string[]
    specificUsers?: Array<{ id?: string; email?: string; phone?: string; name?: string }>
  }
): Promise<number> {
  let rows: Array<{ broadcast_id: string; user_id: string | null; email: string | null; phone: string | null; name: string | null }> = []

  if (opts.targetType === "roles") {
    const roles = opts.roles || []
    if (roles.length === 0) return 0

    // Page through users so large audiences are fully enqueued.
    let page = 0
    const pageSize = 1000
    let hasMore = true
    while (hasMore) {
      const { data, error } = await supabase
        .from("users")
        .select("id, email, phone_number, first_name, role")
        .in("role", roles)
        .range(page * pageSize, (page + 1) * pageSize - 1)
      if (error) throw error
      if (data && data.length > 0) {
        rows.push(
          ...data.map((u: any) => ({
            broadcast_id: broadcastId,
            user_id: u.id,
            email: u.email || null,
            phone: u.phone_number || null,
            name: u.first_name || null,
          }))
        )
        hasMore = data.length === pageSize
        page++
      } else {
        hasMore = false
      }
    }
  } else {
    rows = (opts.specificUsers || []).map((u) => ({
      broadcast_id: broadcastId,
      user_id: u.id || null,
      email: u.email || null,
      phone: u.phone || null,
      name: u.name || null,
    }))
  }

  if (rows.length === 0) return 0

  // Insert in chunks to stay under payload limits on big audiences.
  const chunkSize = 500
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { error } = await supabase.from("broadcast_recipients").insert(rows.slice(i, i + chunkSize))
    if (error) throw error
  }
  return rows.length
}

/**
 * Send one recipient across every channel that (a) the broadcast targets, (b)
 * the recipient has contact info for, and (c) hasn't already succeeded. Returns
 * the updated per-channel status. Channels that already succeeded on a prior
 * attempt are left untouched so a retry never double-sends.
 */
async function processRecipient(broadcast: BroadcastRow, r: RecipientRow): Promise<Record<string, ChannelOutcome>> {
  const status: Record<string, ChannelOutcome> = { ...(r.channel_status || {}) }
  const channels = broadcast.channels || []

  const alreadyDone = (ch: string) => status[ch] === "sent" || status[ch] === "skipped"
  // On a fresh channel attempt we let the provider log the message; on a retry
  // we skip logging so the Emails/SMS history tabs don't accumulate duplicates.
  const isRetry = (ch: string) => status[ch] === "failed"

  // Email
  if (channels.includes("email") && !alreadyDone("email")) {
    if (!r.email) {
      status.email = "skipped"
    } else {
      try {
        const emailData = EmailTemplates.broadcastMessage(broadcast.subject || "Notification", broadcast.message)
        const res = await sendEmail({
          to: [{ email: r.email, name: r.name || "User" }],
          subject: emailData.subject,
          htmlContent: emailData.html,
          userId: r.user_id || undefined,
          type: "broadcast",
          referenceId: broadcast.id,
          skipLogging: isRetry("email"),
        })
        status.email = res.success ? "sent" : "failed"
      } catch {
        status.email = "failed"
      }
    }
  }

  // SMS
  if (channels.includes("sms") && !alreadyDone("sms")) {
    if (!r.phone) {
      status.sms = "skipped"
    } else {
      try {
        const res = await sendSMS({
          phone: r.phone,
          message: broadcast.message,
          type: "broadcast",
          userId: r.user_id || undefined,
          reference: broadcast.id,
          skipLogging: isRetry("sms"),
        })
        status.sms = res.success ? "sent" : "failed"
      } catch {
        status.sms = "failed"
      }
    }
  }

  // Push
  if (channels.includes("push") && !alreadyDone("push")) {
    if (!r.user_id) {
      status.push = "skipped"
    } else {
      try {
        const { sent, removed } = await sendPushToUser(r.user_id, {
          title: broadcast.subject || "Notification",
          body: broadcast.message,
          data: { url: "/dashboard" },
        })
        // sent>0: delivered. removed>0: expired subscription = failed. else: not
        // subscribed = skipped (nothing we can retry).
        status.push = sent > 0 ? "sent" : removed > 0 ? "failed" : "skipped"
      } catch {
        status.push = "failed"
      }
    }
  }

  // WhatsApp: free-form text only lands inside the 24h customer-service window
  // (sendWhatsAppText returns false rather than throwing on failure). Outside
  // it, fall back to the approved "datagod_broadcast" marketing template —
  // body placeholder {{1}} carries the broadcast message. Template params
  // can't contain newlines, so collapse them for that path only.
  if (channels.includes("whatsapp") && !alreadyDone("whatsapp")) {
    if (!r.phone) {
      status.whatsapp = "skipped"
    } else {
      try {
        const raw = String(r.phone).replace(/\s/g, "")
        const waPhone = raw.startsWith("0") ? `233${raw.slice(1)}` : raw.replace(/^\+/, "")
        let ok = await sendWhatsAppText(waPhone, broadcast.message)
        if (!ok) {
          ok = await sendWhatsAppTemplate(waPhone, "datagod_broadcast", "en", [
            { type: "body", parameters: [{ type: "text", text: broadcast.message.replace(/\s*\n+\s*/g, " ") }] },
          ])
        }
        status.whatsapp = ok ? "sent" : "failed"
      } catch {
        status.whatsapp = "failed"
      }
    }
  }

  return status
}

/** A recipient is failed if any channel it actually attempted ended in failure. */
function deriveRowStatus(channelStatus: Record<string, ChannelOutcome>): "sent" | "failed" {
  return Object.values(channelStatus).some((s) => s === "failed") ? "failed" : "sent"
}

/**
 * Claim and process up to `budget` recipients for one broadcast. Returns how
 * many it processed so the caller can spread a global budget across broadcasts.
 */
async function drainOne(supabase: SupabaseClient, broadcast: BroadcastRow, budget: number): Promise<number> {
  const { data: claimed, error } = await supabase.rpc("claim_broadcast_recipients", {
    bid: broadcast.id,
    lim: budget,
    max_attempts: MAX_ATTEMPTS,
  })
  if (error) throw error
  const rows = (claimed || []) as RecipientRow[]
  if (rows.length === 0) return 0

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    if (i > 0) await new Promise((res) => setTimeout(res, SUB_BATCH_DELAY_MS))
    const batch = rows.slice(i, i + CONCURRENCY)
    await Promise.all(
      batch.map(async (r) => {
        let channelStatus: Record<string, ChannelOutcome>
        let rowStatus: "sent" | "failed"
        try {
          channelStatus = await processRecipient(broadcast, r)
          rowStatus = deriveRowStatus(channelStatus)
        } catch (e: any) {
          // Unexpected error: leave channel_status as-is, mark failed so it can
          // be retried up to the cap.
          channelStatus = r.channel_status || {}
          rowStatus = "failed"
          await supabase
            .from("broadcast_recipients")
            .update({ status: "failed", last_error: String(e?.message || e), processed_at: new Date().toISOString() })
            .eq("id", r.id)
          return
        }
        await supabase
          .from("broadcast_recipients")
          .update({
            status: rowStatus,
            channel_status: channelStatus,
            last_error: rowStatus === "failed" ? "one or more channels failed" : null,
            processed_at: new Date().toISOString(),
          })
          .eq("id", r.id)
      })
    )
  }

  await supabase.rpc("recompute_broadcast_results", { bid: broadcast.id, max_attempts: MAX_ATTEMPTS })
  return rows.length
}

/**
 * Main drain entry point. Reaps stale claims, then works through in-flight
 * broadcasts (oldest first) until the per-run budget is spent. Safe to run
 * concurrently with itself thanks to the SKIP LOCKED claim.
 */
export async function drainBroadcasts(
  supabase: SupabaseClient,
  opts: { maxRecipients?: number; broadcastId?: string } = {}
): Promise<{ processed: number; broadcasts: number }> {
  // 1. Hand stranded claims back to the queue.
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
  await supabase
    .from("broadcast_recipients")
    .update({ status: "pending" })
    .eq("status", "claimed")
    .lt("claimed_at", cutoff)

  // 2. Which broadcasts to drain.
  let query = supabase
    .from("broadcast_logs")
    .select("id, channels, subject, message")
    .eq("status", "processing")
    .order("created_at", { ascending: true })
    .limit(10)
  if (opts.broadcastId) query = supabase.from("broadcast_logs").select("id, channels, subject, message").eq("id", opts.broadcastId)

  const { data: broadcasts, error } = await query
  if (error) throw error
  if (!broadcasts || broadcasts.length === 0) return { processed: 0, broadcasts: 0 }

  let budget = opts.maxRecipients ?? MAX_RECIPIENTS_PER_RUN
  let processed = 0
  let touched = 0

  for (const b of broadcasts as BroadcastRow[]) {
    if (budget <= 0) break
    const n = await drainOne(supabase, b, budget)
    if (n > 0) {
      processed += n
      budget -= n
      touched++
    }
  }

  return { processed, broadcasts: touched }
}
