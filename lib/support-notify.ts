import { after } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { sendPushToUser } from "@/lib/push-service"
import { alertAdminsOfRequest } from "@/lib/admin-actions"

export type SupportUserEvent = "received" | "replied" | "closed"

const COMPLAINTS_URL = "/dashboard/complaints"

const COPY: Record<SupportUserEvent, { title: string; message: string }> = {
  received: { title: "We received your complaint", message: "Our support team will reply here shortly." },
  replied: { title: "Support replied to your complaint", message: "Open Support & Complaints to read the reply." },
  closed: { title: "Your complaint was closed", message: "Open a new complaint if you still need help." },
}

/** In-app notification plus push. Each step is isolated; this never rejects. Logs ids only. */
export async function notifyUserSupportEvent(
  db: SupabaseClient,
  userId: string,
  event: SupportUserEvent,
  threadId: string,
): Promise<void> {
  const { title, message } = COPY[event]
  try {
    const { error } = await db.from("notifications").insert({
      user_id: userId, title, message, type: "support_reply",
      reference_id: threadId, action_url: COMPLAINTS_URL, read: false,
    })
    if (error) console.error("[SUPPORT] notification insert failed", { threadId, event })
  } catch {
    console.error("[SUPPORT] notification insert threw", { threadId, event })
  }
  try {
    await sendPushToUser(userId, { title, body: message, data: { url: COMPLAINTS_URL } })
  } catch {
    console.error("[SUPPORT] push failed", { threadId, event })
  }
}

/** Alert admins of a new thread. Never rejects. */
export async function alertAdminsNewThread(args: { threadId: string; subject: string; summary: string }): Promise<void> {
  try {
    await alertAdminsOfRequest("complaint", {
      complaintId: args.threadId,
      summary: args.summary.slice(0, 200),
      url: "/admin/complaints",
      customerLabel: args.subject,
    })
  } catch {
    console.error("[SUPPORT] admin alert failed", { threadId: args.threadId })
  }
}

/** `after()` outside a request scope (unit tests) throws: fall back to a detached best-effort run. */
export function runAfterResponse(task: () => Promise<void>): void {
  try {
    after(task)
  } catch {
    void task().catch(() => {
      console.error("[SUPPORT] deferred task failed")
    })
  }
}
