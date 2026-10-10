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

export async function pollHubtelDeliveries(opts: { maxBatches?: number; maxSingles?: number; now?: number; deadlineMs?: number } = {}): Promise<PollSummary> {
  const sum: PollSummary = { batches: 0, singles: 0, delivered: 0, failed: 0, refunded: 0, closed: 0, errors: 0 }
  const baseCfg = hubtelConfigFromEnv()
  if (!baseCfg) return sum
  const cfg = { ...baseCfg, timeoutMs: 8000 } // status GETs: fail fast so one slow call can't eat the budget
  const now = opts.now ?? Date.now()
  const readyBefore = new Date(now - MIN_AGE_MS).toISOString()
  const giveUpBefore = new Date(now - DLR_GIVE_UP_MS).toISOString()
  const timeUp = () => opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs
  const touched = new Set<number>()

  const markChecked = async (batchIds: string[], messageIds: string[]) => {
    if (batchIds.length === 0 && messageIds.length === 0) return
    const { error } = await supabaseAdmin.rpc("mark_sms_dlr_checked", { p_batch_ids: batchIds, p_message_ids: messageIds })
    if (error) { sum.errors++; console.error("[SMS-DLR] mark checked failed:", error.message) }
  }

  try {
    // 0. Close anything still pending after 72 h as failed (locked, re-checked, refunded once in SQL).
    // Pure DB work, so it runs first and always (ignores the deadline): owed refunds must not be
    // starved by slow Hubtel calls.
    {
      const { data: closed, error: closeErr } = await supabaseAdmin.rpc("close_stale_sms_deliveries", { p_before: giveUpBefore, p_limit: 200 })
      if (closeErr) { sum.errors++; console.error("[SMS-DLR] 72h close failed:", closeErr.message) }
      for (const c of (closed ?? []) as { out_message_id: string; out_send_log_id: number; out_refunded: boolean }[]) {
        sum.closed++
        if (c.out_refunded) sum.refunded++
        touched.add(c.out_send_log_id)
      }
    }

    // 1. Batches with pending messages (least-recently-checked first).
    if (!timeUp()) {
      const { data: pend, error: pendErr } = await supabaseAdmin.rpc("pick_sms_dlr_batches", {
        p_ready_before: readyBefore, p_give_up_before: giveUpBefore, p_limit: opts.maxBatches ?? 20,
      })
      if (pendErr) { sum.errors++; console.error("[SMS-DLR] batch discovery failed:", pendErr.message) }
      const checked: string[] = []
      try {
        for (const r of (pend ?? []) as { provider_batch_id: string }[]) {
          if (timeUp()) break
          const batchId = r.provider_batch_id
          checked.push(batchId)
          const res = await hubtelGetBatchStatus(cfg, batchId)
          sum.batches++
          if (!res.ok) { sum.errors++; console.error("[SMS-DLR] batch status failed:", batchId, res.error); continue }
          await apply(toDeliveryReports(res.messages), touched, sum)
        }
      } finally {
        await markChecked(checked, [])
      }
    }

    // 2. Drain-sent singles (message id, no batch).
    if (!timeUp()) {
      const { data: singles, error: singlesErr } = await supabaseAdmin.rpc("pick_sms_dlr_singles", {
        p_ready_before: readyBefore, p_give_up_before: giveUpBefore, p_limit: opts.maxSingles ?? 50,
      })
      if (singlesErr) { sum.errors++; console.error("[SMS-DLR] singles discovery failed:", singlesErr.message) }
      const checked: string[] = []
      try {
        for (const s of (singles ?? []) as { provider_message_id: string }[]) {
          if (timeUp()) break
          const messageId = s.provider_message_id
          checked.push(messageId)
          const res = await hubtelGetMessageStatus(cfg, messageId)
          sum.singles++
          if (!res.ok) { sum.errors++; console.error("[SMS-DLR] message status failed:", messageId, res.error); continue }
          await apply(toDeliveryReports(res.messages), touched, sum)
        }
      } finally {
        await markChecked([], checked)
      }
    }
  } finally {
    // 4. Roll campaigns up — always, even if a phase threw.
    for (const id of touched) {
      const { error } = await supabaseAdmin.rpc("recompute_sms_send_result", { p_send_log_id: id, max_attempts: 3 })
      if (error) { sum.errors++; console.error("[SMS-DLR] recompute failed:", id, error.message) }
    }
  }
  return sum
}
