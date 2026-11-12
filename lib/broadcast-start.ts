// Starting a broadcast: the broadcast_logs row, the persisted recipient list, the first synchronous batch.
// Shared by POST /api/admin/broadcast (action "init") and POST /api/admin/users/bulk (action "notify"), so the
// admin users page sends through exactly the same queue, pacing, retries and history as the Broadcast page.
import type { SupabaseClient } from "@supabase/supabase-js"
import { drainBroadcasts, enqueueRecipients } from "@/lib/broadcast-drain"
import { providerColumnMissingMessage } from "@/lib/sms/provider-pick"
import { BROADCAST_LIMITS } from "@/lib/broadcast-limits"

export { BROADCAST_LIMITS }

export type BroadcastRecipient = { id?: string; email?: string; phone?: string; name?: string; renderedMessage?: string }

export type StartBroadcastResult =
  | { ok: true; broadcastId: string; total: number }
  | { ok: false; status: number; error: string }

export async function startBroadcast(
  supabase: SupabaseClient,
  opts: {
    adminId: string | null | undefined
    channels: string[]
    targetType: string
    targetGroup: string[]
    subject: string
    message: string
    /** parseSmsProvider's value; only an explicit moolre / hubtel pick is stored. */
    smsProvider?: string | null
    recipients: { targetType: "roles"; roles: string[] } | { targetType: "specific"; users: BroadcastRecipient[] }
  },
): Promise<StartBroadcastResult> {
  const { channels, smsProvider } = opts
  const { data: broadcastLog, error: logError } = await supabase
    .from("broadcast_logs")
    .insert({
      admin_id: opts.adminId,
      channels,
      target_type: opts.targetType,
      target_group: opts.targetGroup,
      subject: opts.subject,
      message: opts.message,
      status: "processing",
      // Only written for an explicit pick on an SMS broadcast, so ordinary
      // broadcasts never touch the column (works before the migration).
      ...((smsProvider === "moolre" || smsProvider === "hubtel") && channels.includes("sms") ? { sms_provider: smsProvider } : {}),
      results: {
        total: 0,
        sms: { sent: 0, failed: 0, pending: 0 },
        email: { sent: 0, failed: 0, pending: 0 },
        push: { sent: 0, failed: 0 },
        whatsapp: { sent: 0, failed: 0 },
      },
    })
    .select()
    .single()

  if (logError) {
    const missing = providerColumnMissingMessage(logError, (smsProvider ?? null) as any)
    if (missing) return { ok: false, status: 409, error: missing }
    throw logError
  }
  const broadcastId = (broadcastLog as { id: string }).id

  // Persist the full recipient list so the cron can finish the send.
  const enqueued = await enqueueRecipients(
    supabase,
    broadcastId,
    opts.recipients.targetType === "roles"
      ? { targetType: "roles", roles: opts.recipients.roles }
      : { targetType: "specific", specificUsers: opts.recipients.users },
  )
  if (enqueued === 0) {
    await supabase.from("broadcast_logs").update({ status: "completed" }).eq("id", broadcastId)
    return { ok: false, status: 400, error: "No recipients matched the selected criteria" }
  }

  // Set the real total, then send the first batch synchronously so the admin sees immediate progress. Anything
  // left over is handled by the drain-broadcasts cron, including if the tab closes right now.
  await supabase.rpc("recompute_broadcast_results", { bid: broadcastId, max_attempts: 3 })
  await drainBroadcasts(supabase, { broadcastId, maxRecipients: BROADCAST_LIMITS.firstBatch }).catch((e) => {
    console.error("[BROADCAST] first drain failed (cron will retry):", e)
  })
  return { ok: true, broadcastId, total: enqueued }
}
