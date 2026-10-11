/**
 * Shared claim → dispatch → mark → hand-back → recompute sequence, factored out of held-service
 * (enqueueSend's inline step 7 in send-service is a separate copy and is left alone).
 * Used by held-campaign release and the scheduled-send dispatcher. The Supabase client is a parameter.
 */
import type { SupabaseClient } from "@supabase/supabase-js"
import { dispatchCampaign, type SentRow } from "./campaign-dispatch"

/** Must match send-drain's MAX_ATTEMPTS / recompute_sms_send_result's default. */
export const MAX_ATTEMPTS = 3
/** Same as enqueueSend: stop starting chunks 1 min before the drain's 5-min stale-claim reaper. */
export const DISPATCH_WINDOW_MS = 4 * 60_000
/** Ids per hand-back update (keeps the .in() filter well inside URL limits). */
export const RELEASE_CHUNK = 100

export interface ClaimedItem { id: string; phone: string; message: string }

/**
 * Claim the still-pending rows of a log for an instant dispatch (conditional, so no row is
 * double-claimed). Returns [] on error: the log is already queued, so the drain sends the rows.
 */
export async function claimPendingForLog(db: SupabaseClient, sendLogId: number): Promise<ClaimedItem[]> {
  const claimedAt = new Date()
  const { data: claimed, error: claimErr } = await db
    .from("sms_messages")
    .update({ status: "claimed", claimed_at: claimedAt.toISOString() })
    .eq("send_log_id", sendLogId)
    .eq("status", "pending")
    .select("id, phone, rendered_message")
  if (claimErr) console.error("[SMS-HELD] claim failed; the drain will send the campaign:", claimErr.message)
  return ((claimErr ? [] : claimed ?? []) as { id: string; phone: string; rendered_message: string }[])
    .map((m) => ({ id: m.id, phone: m.phone, message: m.rendered_message }))
}

/**
 * Dispatch rows this caller has claimed, exactly as enqueueSend step 7 does (that code lives in
 * send-service and is not exported): per-chunk mark-sent with retries and a plain-update fallback,
 * Hubtel "unknown" tagging, first batch id on the log, unplaced rows handed back to the drain,
 * then the parent status rollup. Returns how many rows a provider accepted.
 */
export async function dispatchClaimed(
  db: SupabaseClient,
  sendLogId: number,
  items: ClaimedItem[],
  senderId: string | null,
  claimedAtMs: number,
): Promise<number> {
  const placedUnmarked = new Set<string>()
  let placed = 0
  try {
    if (items.length > 0) {
      const mark = async (provider: string, rows: SentRow[], info: { unconfirmed: boolean }) => {
        if (rows.length === 0) return
        let error: { message?: string } | null = null
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 250 : 1000))
          ;({ error } = await db.rpc("mark_sms_messages_sent", { p_provider: provider, p_rows: rows }))
          if (!error) break
        }
        if (error) {
          console.error(`[SMS-HELD] mark-sent RPC (${provider}) failed after retries; trying plain update:`, error.message)
          const ids = rows.map((r) => r.id)
          const { error: fbErr } = await db
            .from("sms_messages")
            .update({ status: "sent", provider, processed_at: new Date().toISOString() })
            .in("id", ids)
            .eq("status", "claimed")
          if (fbErr) {
            console.error(`[SMS-HELD] mark-sent fallback (${provider}) failed; rows held for the reaper:`, fbErr.message)
            for (const id of ids) placedUnmarked.add(id)
            return
          }
        }
        if (provider === "hubtel" && info.unconfirmed) {
          const { error: tagErr } = await db
            .from("sms_messages")
            .update({ last_error: "hubtel_unconfirmed" })
            .in("id", rows.map((r) => r.id))
          if (tagErr) console.error("[SMS-HELD] unconfirmed tagging failed:", tagErr.message)
        }
      }
      const result = await dispatchCampaign(items, senderId, mark, claimedAtMs + DISPATCH_WINDOW_MS)
      placed = result.sent.length + result.fallbackSent.length
      const firstBatch = result.sent.find((r) => r.bid)?.bid
      if (firstBatch) {
        await db.from("sms_send_logs").update({ provider_batch_id: firstBatch, provider: "hubtel" }).eq("id", sendLogId)
      }
    }
  } catch (e) {
    console.error("[SMS-HELD] dispatch failed (rows stay pending for the drain):", e)
  } finally {
    // Hand back ONLY the rows this call claimed. After the held→queued flip the cron drain may have
    // claimed other rows of this log and still be sending them: never reset those (double send).
    // Placed rows are already 'sent' (the status filter skips them); placed-but-unmarked rows stay
    // claimed for the reaper. Chunked: a 500-id .in() would overflow the request URL.
    const mine = items.map((i) => i.id).filter((id) => !placedUnmarked.has(id))
    for (let i = 0; i < mine.length; i += RELEASE_CHUNK) {
      try {
        const { error: relErr } = await db
          .from("sms_messages")
          .update({ status: "pending", claimed_at: null })
          .eq("send_log_id", sendLogId)
          .eq("status", "claimed")
          .in("id", mine.slice(i, i + RELEASE_CHUNK))
        if (relErr) console.error("[SMS-HELD] release of unplaced rows failed (stale-claim reaper will recover):", relErr.message)
      } catch (e) {
        console.error("[SMS-HELD] release of unplaced rows threw (stale-claim reaper will recover):", e)
      }
    }
  }
  try {
    const { error } = await db.rpc("recompute_sms_send_result", { p_send_log_id: sendLogId, max_attempts: MAX_ATTEMPTS })
    if (error) console.warn("[SMS-HELD] recompute failed:", error)
  } catch { /* non-fatal: the drain recomputes too */ }
  return placed
}
