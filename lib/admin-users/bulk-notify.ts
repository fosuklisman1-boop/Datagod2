// Server-side: the "notify" bulk action of POST /api/admin/users/bulk.
//   in_app  one public.notifications row per user (type 'admin_action'), the same table and columns the other
//           admin routes write; the Supabase webhook on notifications INSERT also pushes it to the mobile app.
//   push    web push, and
//   sms     SMS, both through the Broadcast page's own path (lib/broadcast-start.ts: broadcast_logs +
//           broadcast_recipients, first 30 sent now, the drain-broadcasts cron sends the rest with its pacing and
//           3 attempts). The send then shows in Broadcast history like any other broadcast.
import type { SupabaseClient } from "@supabase/supabase-js"
import { startBroadcast } from "@/lib/broadcast-start"
import type { NotifyChannel } from "./bulk-params"

export interface NotifyRecipient {
  id: string
  email: string | null
  phone: string | null
  name: string | null
}

export type ChannelOutcome = "sent" | "queued" | "failed"

export interface BulkUserResult {
  id: string
  ok: boolean
  error?: string
  /** Something the admin should know that is not a failure, e.g. "no phone number: SMS skipped". */
  note?: string
  /** notify only: what happened on each requested channel (in_app sent / failed; push, sms queued / failed). */
  channels?: Partial<Record<NotifyChannel, ChannelOutcome>>
}

/**
 * In-app rows per insert. Each inserted notifications row also fires the Supabase webhook that pushes it to the
 * user's mobile devices (app/api/push/dispatch), so rows go in small batches with a short pause between them
 * rather than 5000 webhook calls at once.
 */
export const IN_APP_CHUNK = 100
export const IN_APP_PAUSE_MS = 250

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function sendBulkNotification(
  db: SupabaseClient,
  opts: { adminId: string; recipients: NotifyRecipient[]; title: string; message: string; channels: NotifyChannel[] },
): Promise<{ results: BulkUserResult[]; delivered: Map<string, NotifyChannel[]>; broadcastId: string | null; broadcastError: string | null }> {
  const { recipients, title, message, channels } = opts
  const inAppFailed = new Set<string>()

  if (channels.includes("in_app")) {
    for (let i = 0; i < recipients.length; i += IN_APP_CHUNK) {
      if (i > 0) await sleep(IN_APP_PAUSE_MS)
      const chunk = recipients.slice(i, i + IN_APP_CHUNK)
      const { error } = await db.from("notifications").insert(chunk.map((r) => ({
        user_id: r.id, title, message, type: "admin_action", action_url: "/dashboard", read: false,
      })))
      if (error) {
        console.error("[ADMIN-BULK-NOTIFY] in-app insert failed:", error.message)
        for (const r of chunk) inAppFailed.add(r.id)
      }
    }
  }

  let broadcastId: string | null = null
  let broadcastError: string | null = null
  const broadcastChannels = channels.filter((c): c is "push" | "sms" => c === "push" || c === "sms")
  if (broadcastChannels.length) {
    try {
      const started = await startBroadcast(db, {
        adminId: opts.adminId,
        channels: broadcastChannels,
        targetType: "specific",
        targetGroup: ["admin_users_bulk"],
        subject: title,
        message,
        recipients: {
          targetType: "specific",
          users: recipients.map((r) => ({ id: r.id, email: r.email ?? undefined, phone: r.phone ?? undefined, name: r.name ?? undefined })),
        },
      })
      if (started.ok) broadcastId = started.broadcastId
      else broadcastError = started.error
    } catch (e: any) {
      console.error("[ADMIN-BULK-NOTIFY] broadcast failed:", e?.message ?? e)
      broadcastError = "Push / SMS could not be queued"
    }
  }
  const bLabel = broadcastChannels.map((c) => (c === "sms" ? "SMS" : "push")).join("/")
  const bFailText = (first: boolean) => `${first ? bLabel[0].toUpperCase() + bLabel.slice(1) : bLabel} not queued (${broadcastError})`

  const delivered = new Map<string, NotifyChannel[]>()
  const results = recipients.map((r): BulkUserResult => {
    const outcome: Partial<Record<NotifyChannel, ChannelOutcome>> = {}
    if (channels.includes("in_app")) outcome.in_app = inAppFailed.has(r.id) ? "failed" : "sent"
    for (const c of broadcastChannels) outcome[c] = broadcastError ? "failed" : "queued"
    const ok = channels.filter((c) => outcome[c] !== "failed")
    delivered.set(r.id, ok)

    const failures: string[] = []
    if (outcome.in_app === "failed") failures.push("In-app notification not saved")
    if (broadcastChannels.length && broadcastError) failures.push(bFailText(failures.length === 0))
    if (ok.length === 0) return { id: r.id, ok: false, error: failures.join("; "), channels: outcome }
    const notes = [...failures]
    if (outcome.sms === "queued" && !r.phone) notes.push("No phone number: SMS skipped")
    return notes.length ? { id: r.id, ok: true, note: notes.join("; "), channels: outcome } : { id: r.id, ok: true, channels: outcome }
  })
  return { results, delivered, broadcastId, broadcastError }
}
