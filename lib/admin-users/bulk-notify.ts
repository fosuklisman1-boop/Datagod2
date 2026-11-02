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

export interface BulkUserResult {
  id: string
  ok: boolean
  error?: string
  /** Something the admin should know that is not a failure, e.g. "no phone number: SMS skipped". */
  note?: string
}

const IN_APP_CHUNK = 500

export async function sendBulkNotification(
  db: SupabaseClient,
  opts: { adminId: string; recipients: NotifyRecipient[]; title: string; message: string; channels: NotifyChannel[] },
): Promise<{ results: BulkUserResult[]; broadcastId: string | null; broadcastError: string | null }> {
  const { recipients, title, message, channels } = opts
  const failed = new Map<string, string>()

  if (channels.includes("in_app")) {
    for (let i = 0; i < recipients.length; i += IN_APP_CHUNK) {
      const chunk = recipients.slice(i, i + IN_APP_CHUNK)
      const { error } = await db.from("notifications").insert(chunk.map((r) => ({
        user_id: r.id, title, message, type: "admin_action", action_url: "/dashboard", read: false,
      })))
      if (error) {
        console.error("[ADMIN-BULK-NOTIFY] in-app insert failed:", error.message)
        for (const r of chunk) failed.set(r.id, "In-app notification could not be saved")
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
    if (broadcastError) {
      for (const r of recipients) failed.set(r.id, [failed.get(r.id), broadcastError].filter(Boolean).join("; "))
    }
  }

  const results = recipients.map((r): BulkUserResult => {
    const error = failed.get(r.id)
    if (error) return { id: r.id, ok: false, error }
    const note = channels.includes("sms") && !r.phone ? "No phone number: SMS skipped" : undefined
    return note ? { id: r.id, ok: true, note } : { id: r.id, ok: true }
  })
  return { results, broadcastId, broadcastError }
}
