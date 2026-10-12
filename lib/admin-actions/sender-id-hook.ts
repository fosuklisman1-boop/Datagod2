import { notifyUserOfOutcome } from "@/lib/admin-actions"

/** Minimal sms_sender_ids row shape needed to tell the requesting tenant the outcome. */
export interface SenderIdRow {
  id: string
  sender_id: string
  sms_account_id: string | null
}

/** Structural subset of a Supabase client (service role), so tests can fake it. */
type Db = { from(table: string): any }

/**
 * Tell the tenant their sender-ID request was approved/rejected (flow: sender_id).
 * Call ONLY after the service reported a real pending -> active/rejected transition.
 * Platform-owned IDs (no sms_account_id) have nobody to notify. Never throws; await it.
 */
export async function notifySenderIdOutcome(
  db: Db,
  row: SenderIdRow,
  outcome: "approved" | "rejected",
  reason?: string,
): Promise<void> {
  try {
    if (!row?.id || !row.sms_account_id) return
    const { data: account } = await db.from("sms_accounts").select("user_id").eq("id", row.sms_account_id).maybeSingle()
    if (!account?.user_id) return
    await notifyUserOfOutcome("sender_id", outcome, { userId: account.user_id, reference: row.id }, {
      senderIdId: row.id,
      senderId: row.sender_id,
      reason,
    })
  } catch (err) {
    console.warn("[ADMIN-ACTION] sender-id notify failed:", err instanceof Error ? err.message : err)
  }
}
