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

/**
 * One RPC row. `bid` + `to` are set only for batch-status reports: Hubtel's batch status reply
 * uses message ids that differ from the ids its send reply gave us, so apply_sms_delivery_reports
 * falls back to matching (provider_batch_id, recipient), one report to at most one message.
 * Singles carry null for both and match by message id only.
 */
export interface DeliveryReportRow {
  mid: string; state: "delivered" | "failed" | "pending"; rate: number | null; at: string | null
  bid: string | null; to: string | null
}
export function toDeliveryReports(entries: HubtelStatusEntry[], batchId?: string): DeliveryReportRow[] {
  return entries.map((e) => ({
    mid: e.messageId,
    state: e.state,
    rate: e.rate ?? null,
    // Hubtel's updateTime has no zone ("2023-03-21T12:54:43"); Ghana is UTC+0.
    at: e.updateTime ? (/[zZ]|[+-]\d\d:?\d\d$/.test(e.updateTime) ? e.updateTime : `${e.updateTime}Z`) : null,
    bid: batchId ?? null,
    to: batchId ? e.to ?? null : null,
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

export interface PollSummary {
  batches: number; singles: number; delivered: number; failed: number; refunded: number; closed: number; errors: number
  /** Platform SMS (OTPs, receipts, notifications) logged in sms_logs and sent through Hubtel. */
  logsChecked: number; logsDelivered: number; logsFailed: number
}

/** sms_logs rows sent via Hubtel are checked for this long (newest first), then left as 'sent'. */
export const LOG_DLR_WINDOW_MS = 24 * 3_600_000

async function apply(rows: DeliveryReportRow[], touched: Set<number>, sum: PollSummary) {
  if (rows.length === 0) return
  const { data, error } = await supabaseAdmin.rpc("apply_sms_delivery_reports", { p_rows: rows })
  if (error) { sum.errors++; console.error("[SMS-DLR] apply failed:", error.message); return }
  const s = summarizeApplied((data ?? []) as AppliedRow[])
  sum.delivered += s.delivered; sum.failed += s.failed; sum.refunded += s.refunded
  s.sendLogIds.forEach((id) => touched.add(id))
}

export async function pollHubtelDeliveries(opts: { maxBatches?: number; maxSingles?: number; maxLogs?: number; now?: number; deadlineMs?: number } = {}): Promise<PollSummary> {
  const sum: PollSummary = { batches: 0, singles: 0, delivered: 0, failed: 0, refunded: 0, closed: 0, errors: 0, logsChecked: 0, logsDelivered: 0, logsFailed: 0 }
  const baseCfg = hubtelConfigFromEnv()
  if (!baseCfg) {
    console.warn("[SMS-DLR] Hubtel credentials not set (HUBTEL_SMS_CLIENT_ID / HUBTEL_SMS_CLIENT_SECRET): nothing polled")
    return sum
  }
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
          await apply(toDeliveryReports(res.messages, batchId), touched, sum)
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

    // 3. Platform SMS (sms_logs: OTPs, receipts, notifications) sent through Hubtel. The provider
    // message id is stored in moolre_message_id (shared column). No refunds here: these are not
    // billed to a customer's SMS balance. Newest first, so a few never-final rows can't starve
    // fresh ones; anything older than LOG_DLR_WINDOW_MS stays 'sent'.
    if (!timeUp()) {
      const { data: logs, error: logsErr } = await supabaseAdmin
        .from("sms_logs")
        .select("id, moolre_message_id")
        .eq("provider", "hubtel")
        .eq("status", "sent")
        .not("moolre_message_id", "is", null)
        .lte("created_at", readyBefore)
        .gte("created_at", new Date(now - LOG_DLR_WINDOW_MS).toISOString())
        .order("created_at", { ascending: false })
        .limit(opts.maxLogs ?? 60)
      if (logsErr) { sum.errors++; console.error("[SMS-DLR] sms_logs discovery failed:", logsErr.message) }
      for (const row of (logs ?? []) as { id: string; moolre_message_id: string }[]) {
        if (timeUp()) break
        const res = await hubtelGetMessageStatus(cfg, row.moolre_message_id)
        sum.logsChecked++
        if (!res.ok) { sum.errors++; console.error("[SMS-DLR] sms_logs status failed:", row.moolre_message_id, res.error); continue }
        const entry = res.messages[0]
        if (!entry || entry.state === "pending") continue
        const patch = entry.state === "delivered"
          ? { status: "delivered", delivered_at: toDeliveryReports([entry])[0].at ?? new Date().toISOString() }
          : { status: "failed", error_message: `Hubtel: ${entry.rawStatus || "undelivered"}` }
        // Guarded on status='sent' so a concurrent update is never overwritten.
        const { error: upErr } = await supabaseAdmin.from("sms_logs").update(patch).eq("id", row.id).eq("status", "sent")
        if (upErr) { sum.errors++; console.error("[SMS-DLR] sms_logs update failed:", row.id, upErr.message); continue }
        if (entry.state === "delivered") sum.logsDelivered++
        else sum.logsFailed++
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
