// Server helpers for the waiting line, shared by the token route and the check-in route.
// Every function reports a failed read/write (false / null) and the caller fails closed: this path decides who may
// spend paid credits. Never logs identities or ticket ids.
import type { SupabaseClient } from "@supabase/supabase-js"
import { ADMIT_HOLD_MS, QUEUE_STALE_MS, type LiveTicket } from "./queue"

/** Waiting tickets with no check-in for QUEUE_STALE_MS, and admitted tickets unused for ADMIT_HOLD_MS, become expired. */
export async function expireStaleTickets(db: SupabaseClient, nowMs: number = Date.now()): Promise<boolean> {
  const waitingCutoff = new Date(nowMs - QUEUE_STALE_MS).toISOString()
  const admittedCutoff = new Date(nowMs - ADMIT_HOLD_MS).toISOString()
  const [w, a] = await Promise.all([
    db.from("ai_voice_queue").update({ status: "expired" }).eq("status", "waiting").lt("last_seen_at", waitingCutoff),
    db.from("ai_voice_queue").update({ status: "expired" }).eq("status", "admitted").lt("admitted_at", admittedCutoff),
  ])
  return !w.error && !a.error
}

/** Every waiting or admitted ticket, oldest first. null when the read fails. */
export async function readLiveTickets(db: SupabaseClient): Promise<LiveTicket[] | null> {
  const { data, error } = await db.from("ai_voice_queue")
    .select("id, user_id, device_hash, status, created_at")
    .in("status", ["waiting", "admitted"])
    .order("created_at", { ascending: true })
  if (error) return null
  return ((data ?? []) as LiveTicket[]).map((t) => ({ ...t, user_id: t.user_id ?? null, device_hash: t.device_hash ?? null }))
}

/** Sets a ticket's status. `from` makes it a compare-and-set (a racing request cannot undo the other's change). */
export async function setTicketStatus(
  db: SupabaseClient,
  id: string,
  status: "admitted" | "used" | "left" | "expired",
  from?: "waiting" | "admitted",
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  let q = db.from("ai_voice_queue").update({ status, ...extra }).eq("id", id)
  if (from) q = q.eq("status", from)
  const { error } = await q
  return !error
}
