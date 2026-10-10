/**
 * Hubtel delivery reports (spec §5.5). Hubtel's REST API has no DLR webhook, so a cron polls
 * batch status. Final states are applied in SQL (apply_sms_delivery_reports), which refunds
 * each failed message exactly once (refund_sms_message, ref = message id — shared with the
 * drain). Messages still undelivered after 72 h are closed as failed and refunded.
 */
import { createClient } from "@supabase/supabase-js"
import { hubtelConfigFromEnv, hubtelGetBatchStatus, hubtelGetMessageStatus, type HubtelStatusEntry } from "./providers/hubtel"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export const DLR_GIVE_UP_MS = 72 * 3_600_000
const MIN_AGE_MS = 60_000 // give the telco a minute before the first check

export interface DeliveryReportRow { mid: string; state: "delivered" | "failed" | "pending"; rate: number | null; at: string | null }
export function toDeliveryReports(entries: HubtelStatusEntry[]): DeliveryReportRow[] {
  return entries.map((e) => ({
    mid: e.messageId,
    state: e.state,
    rate: e.rate ?? null,
    // Hubtel's updateTime has no zone ("2023-03-21T12:54:43"); Ghana is UTC+0.
    at: e.updateTime ? (/[zZ]|[+-]\d\d:?\d\d$/.test(e.updateTime) ? e.updateTime : `${e.updateTime}Z`) : null,
  }))
}

export interface AppliedRow { out_message_id: string; out_send_log_id: number; out_outcome: string; out_refunded: boolean }
export function summarizeApplied(rows: AppliedRow[]) {
  return {
    delivered: rows.filter((r) => r.out_outcome === "delivered").length,
    failed: rows.filter((r) => r.out_outcome === "failed").length,
    refunded: rows.filter((r) => r.out_refunded).length,
    sendLogIds: [...new Set(rows.map((r) => r.out_send_log_id))],
  }
}

export interface PollSummary { batches: number; singles: number; delivered: number; failed: number; refunded: number; closed: number; errors: number }

async function apply(rows: DeliveryReportRow[], touched: Set<number>, sum: PollSummary) {
  if (rows.length === 0) return
  const { data, error } = await supabaseAdmin.rpc("apply_sms_delivery_reports", { p_rows: rows })
  if (error) { sum.errors++; console.error("[SMS-DLR] apply failed:", error.message); return }
  const s = summarizeApplied((data ?? []) as AppliedRow[])
  sum.delivered += s.delivered; sum.failed += s.failed; sum.refunded += s.refunded
  s.sendLogIds.forEach((id) => touched.add(id))
}

export async function pollHubtelDeliveries(opts: { maxBatches?: number; maxSingles?: number; now?: number } = {}): Promise<PollSummary> {
  const sum: PollSummary = { batches: 0, singles: 0, delivered: 0, failed: 0, refunded: 0, closed: 0, errors: 0 }
  const cfg = hubtelConfigFromEnv()
  if (!cfg) return sum
  const now = opts.now ?? Date.now()
  const readyBefore = new Date(now - MIN_AGE_MS).toISOString()
  const giveUpBefore = new Date(now - DLR_GIVE_UP_MS).toISOString()
  const touched = new Set<number>()

  // 1. Batches with pending messages (oldest first).
  const { data: pend } = await supabaseAdmin.from("sms_messages")
    .select("provider_batch_id").eq("provider", "hubtel").eq("status", "sent").eq("delivery_status", "pending")
    .not("provider_batch_id", "is", null).lte("processed_at", readyBefore).gte("processed_at", giveUpBefore)
    .order("processed_at", { ascending: true }).limit(1000)
  const batchIds = [...new Set(((pend ?? []) as { provider_batch_id: string }[]).map((r) => r.provider_batch_id))]
    .slice(0, opts.maxBatches ?? 20)
  for (const batchId of batchIds) {
    const res = await hubtelGetBatchStatus(cfg, batchId)
    sum.batches++
    if (!res.ok) { sum.errors++; continue }
    await apply(toDeliveryReports(res.messages), touched, sum)
  }

  // 2. Drain-sent singles (message id, no batch).
  const { data: singles } = await supabaseAdmin.from("sms_messages")
    .select("provider_message_id").eq("provider", "hubtel").eq("status", "sent").eq("delivery_status", "pending")
    .is("provider_batch_id", null).not("provider_message_id", "is", null)
    .lte("processed_at", readyBefore).gte("processed_at", giveUpBefore)
    .order("processed_at", { ascending: true }).limit(opts.maxSingles ?? 50)
  for (const s of (singles ?? []) as { provider_message_id: string }[]) {
    const res = await hubtelGetMessageStatus(cfg, s.provider_message_id)
    sum.singles++
    if (!res.ok) { sum.errors++; continue }
    await apply(toDeliveryReports(res.messages), touched, sum)
  }

  // 3. Close anything still pending after 72 h as failed (refunded once).
  const { data: stale } = await supabaseAdmin.from("sms_messages")
    .select("id, send_log_id").eq("provider", "hubtel").eq("status", "sent").eq("delivery_status", "pending")
    .lt("processed_at", giveUpBefore).limit(200)
  for (const m of (stale ?? []) as { id: string; send_log_id: number }[]) {
    const { data, error } = await supabaseAdmin.rpc("refund_sms_message", { p_message_id: m.id })
    if (error) { sum.errors++; continue }
    sum.closed++
    if (data === true) sum.refunded++
    touched.add(m.send_log_id)
  }

  // 4. Roll campaigns up.
  for (const id of touched) {
    const { error } = await supabaseAdmin.rpc("recompute_sms_send_result", { p_send_log_id: id, max_attempts: 3 })
    if (error) { sum.errors++; console.error("[SMS-DLR] recompute failed:", id, error.message) }
  }
  return sum
}
