import { SupabaseClient } from "@supabase/supabase-js"
import { processManualFulfillment } from "@/lib/fulfillment-service"
import { fulfillUssdOrder } from "@/lib/ussd/fulfill"
import { ORDER_TABLES } from "@/lib/order-queue/load-snapshots"
import type { OrderType } from "@/lib/order-queue/types"
import { classifyMessage } from "@/lib/order-queue/failure-reason"
import { loadAutoFulfilSettings } from "@/lib/auto-fulfil/settings"
import { NON_SEND_NOT_PENDING_PREFIX, NON_SEND_SWITCHED_OFF, NON_SEND_UNREADABLE } from "@/lib/auto-fulfil/policy"

// Orders processed per cron tick. Each order = one provider API call; keep
// this low enough that 20 × slowest-provider-latency stays under maxDuration.
const BATCH_SIZE = 20

// At most this many auto-fulfil ('auto') rows per tick; admin rows have priority (claim_fulfillment_queue_split).
export const AUTO_PER_TICK = 5

// Stop starting new sends after this long; the rest of the claimed rows go back to 'pending' unsent.
// Well under maxDuration (300 s) so the tick never runs into the STALE_MS reset window below.
export const TIME_BUDGET_MS = 240_000

// A row stuck in 'processing' for longer than this is considered orphaned
// (its worker died mid-run) and is reset to 'pending' for the next tick.
// COUPLED to `maxDuration` (300 s) in app/api/cron/drain-fulfillment-queue/route.ts:
// claim_fulfillment_queue stamps last_attempted_at once, at claim, and a tick can
// legitimately run until maxDuration. This MUST stay strictly greater than
// maxDuration plus a margin, or a later tick (every minute) resets rows the live
// tick is still going to send and the order is sent to a supplier twice.
// Raise this whenever maxDuration is raised.
export const STALE_MS = 6 * 60 * 1000

type DrainResult = {
  claimed: number
  completed: number
  failed: number
  reset_stale: number
  /** claimed rows put back to 'pending' unsent because the tick ran out of time */
  requeued: number
}

type QueueRow = { id: string; order_id: string; order_type: string; provider: string | null; source?: string | null }

// Must match the auto_fulfil_attempts.outcome CHECK in migrations/0193.
type AttemptOutcome =
  | "sent"
  | "rate_limited"
  | "out_of_balance"
  | "supplier_unavailable"
  | "not_enabled"
  | "no_bundle"
  | "wrong_number"
  | "rejected"
  | "unclassified"
  | "held"
  | "skipped"

const FAILURE_OUTCOMES: readonly AttemptOutcome[] = [
  "rate_limited",
  "out_of_balance",
  "supplier_unavailable",
  "not_enabled",
  "no_bundle",
  "wrong_number",
  "rejected",
]

function failureOutcome(message: string): AttemptOutcome {
  const r = classifyMessage(message)
  return r && (FAILURE_OUTCOMES as readonly string[]).includes(r) ? (r as AttemptOutcome) : "unclassified"
}

/** Fails a queue row WITHOUT calling any supplier (the order was not in a sendable state). Logs ids only. */
async function skipRow(supabase: SupabaseClient, row: { id: string; order_id: string }, reason: string) {
  console.warn(`[FULFILLMENT-QUEUE] order ${row.order_id} skipped: ${reason}`)
  await supabase
    .from("fulfillment_queue")
    .update({ status: "failed", error_message: reason })
    .eq("id", row.id)
}

/** The split claim RPC is not in the database yet (0193 not applied): Postgres undefined_function or PostgREST's "not found". */
function isMissingFunction(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42883" || error?.code === "PGRST202"
}

/**
 * Claims the next batch: admin rows first, at most AUTO_PER_TICK auto rows (claim_fulfillment_queue_split, 0193).
 * If 0193 is not applied yet, falls back to the original claim, whose rows carry no `source` and are sent as admin rows.
 * Any other claim error throws.
 */
async function claimBatch(supabase: SupabaseClient): Promise<QueueRow[]> {
  const { data, error } = await supabase.rpc("claim_fulfillment_queue_split", { p_limit: BATCH_SIZE, p_auto_limit: AUTO_PER_TICK })
  if (!error) return (data ?? []) as QueueRow[]
  if (!isMissingFunction(error)) throw new Error(`claim_fulfillment_queue_split failed: ${error.message}`)
  console.warn("[FULFILLMENT-QUEUE] claim_fulfillment_queue_split missing (0193 not applied); using claim_fulfillment_queue")
  const { data: plain, error: plainErr } = await supabase.rpc("claim_fulfillment_queue", { p_limit: BATCH_SIZE })
  if (plainErr) throw new Error(`claim_fulfillment_queue failed: ${plainErr.message}`)
  return (plain ?? []) as QueueRow[]
}

/**
 * Writes the outcome on the auto row's attempt record. Only an attempt with no outcome yet is written, so a later
 * re-claim of the same queue row can never overwrite (e.g. erase a "sent"). The cron may not have inserted the
 * attempt yet (zero rows matched): fine. Never throws; never affects the queue row. Logs ids only.
 */
async function recordAttempt(supabase: SupabaseClient, row: QueueRow, outcome: AttemptOutcome) {
  try {
    const { data, error } = await supabase
      .from("auto_fulfil_attempts")
      .update({ outcome, finished_at: new Date().toISOString() })
      .eq("queue_id", row.id)
      .is("outcome", null)
      .select("id")
    if (error) console.error(`[FULFILLMENT-QUEUE] queue ${row.id}: attempt outcome not recorded`)
    else if (!data || data.length === 0) console.warn(`[FULFILLMENT-QUEUE] queue ${row.id}: no open attempt row to record on`)
  } catch {
    console.error(`[FULFILLMENT-QUEUE] queue ${row.id}: attempt outcome not recorded`)
  }
}

export async function drainFulfillmentQueue(supabase: SupabaseClient): Promise<DrainResult> {
  const startedAt = Date.now()

  // 1. Reset orphaned 'processing' rows back to 'pending'.
  const staleThreshold = new Date(Date.now() - STALE_MS).toISOString()
  const { data: resetRows } = await supabase
    .from("fulfillment_queue")
    .update({ status: "pending" })
    .eq("status", "processing")
    .lt("last_attempted_at", staleThreshold)
    .select("id")

  // 2. Atomically claim the next batch (admin rows first, at most AUTO_PER_TICK auto rows).
  const claimed = await claimBatch(supabase)
  if (claimed.length === 0) {
    return { claimed: 0, completed: 0, failed: 0, reset_stale: resetRows?.length ?? 0, requeued: 0 }
  }

  let completed = 0
  let failed = 0
  let requeued = 0

  for (let i = 0; i < claimed.length; i++) {
    const row = claimed[i]

    // Out of time: hand this row and every remaining one back unsent for the next tick.
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      const ids = claimed.slice(i).map((r) => r.id)
      const { error } = await supabase
        .from("fulfillment_queue")
        .update({ status: "pending" })
        .in("id", ids)
        .eq("status", "processing")
      if (error) console.error(`[FULFILLMENT-QUEUE] time budget: ${ids.length} rows not handed back (stale reset will recover them)`)
      console.warn(`[FULFILLMENT-QUEUE] time budget reached; ${ids.length} rows back to pending`)
      requeued = ids.length
      break
    }

    const isAuto = row.source === "auto"
    // Set just before the supplier call; an auto row that fails after this is recorded as a send outcome.
    let sendAttempted = false
    let held = false

    try {
      let success: boolean

      if (isAuto) {
        // Re-read the switch for every auto row (at most AUTO_PER_TICK reads): switching off stops the very next send.
        // Fails closed.
        const { settings, valid } = await loadAutoFulfilSettings(supabase)
        if (!(valid && settings.enabled === true)) {
          await skipRow(supabase, row, NON_SEND_SWITCHED_OFF)
          await recordAttempt(supabase, row, "skipped")
          failed++
          continue
        }
      }

      // Re-check the order itself before ANY supplier call. A row can wait minutes in the queue, and meanwhile
      // another path (per-row fulfil, a webhook, an admin status change) may have moved the order on. Every
      // legitimately queued order is still `pending` here; anything else is skipped, never sent twice.
      const source = ORDER_TABLES[row.order_type as OrderType]
      const isUssd = row.order_type === "ussd" || row.order_type === "ussd_shop"
      let order: any = null
      if (source) {
        const base = isUssd ? `id, network, recipient_phone, package_size, ${source.statusCol}` : source.statusCol
        // Automatic rows also re-check payment at send time (admin rows are unchanged).
        const cols = isAuto && source.paidCol ? `${base}, ${source.paidCol}` : base
        const { data, error } = await supabase.from(source.table).select(cols).eq("id", row.order_id).maybeSingle()
        if (error) {
          await skipRow(supabase, row, NON_SEND_UNREADABLE)
          if (isAuto) await recordAttempt(supabase, row, "skipped")
          failed++
          continue
        }
        order = data
      }
      if (!source || !order) {
        await skipRow(supabase, row, NON_SEND_UNREADABLE)
        if (isAuto) await recordAttempt(supabase, row, "skipped")
        failed++
        continue
      }
      const orderStatus = String(order[source.statusCol] ?? "").trim().toLowerCase()
      if (orderStatus !== "pending") {
        await skipRow(supabase, row, `${NON_SEND_NOT_PENDING_PREFIX} (${orderStatus || "unknown"})`)
        if (isAuto) await recordAttempt(supabase, row, "skipped")
        failed++
        continue
      }
      if (isAuto && source.paidCol && String(order[source.paidCol] ?? "").trim().toLowerCase() !== "completed") {
        await skipRow(supabase, row, `${NON_SEND_NOT_PENDING_PREFIX} (payment not completed)`)
        await recordAttempt(supabase, row, "skipped")
        failed++
        continue
      }

      sendAttempted = true
      if (isUssd) {
        const table = row.order_type === "ussd_shop" ? "ussd_shop_orders" : "ussd_orders"
        const ussdOrder = order
        const args = [
          ussdOrder.id,
          ussdOrder.network,
          ussdOrder.recipient_phone,
          ussdOrder.package_size ?? "",
          true,
          table,
          row.provider ?? undefined,  // the admin's chosen supplier (hard pin), same as the shop/bulk/api path
        ] as const
        const result = isAuto
          ? await fulfillUssdOrder(...args, { suppressFailureAlerts: true })
          : await fulfillUssdOrder(...args)
        success = result.success
        held = result.held === true
        if (!result.success) throw new Error(result.message || "USSD fulfillment failed")
      } else {
        const args = [
          row.order_id,
          row.order_type as "shop" | "bulk" | "api",
          row.provider ?? undefined,
          true,  // skipSms — bulk queue, no per-order SMS
        ] as const
        const result = isAuto
          ? await processManualFulfillment(...args, { suppressFailureAlerts: true })
          : await processManualFulfillment(...args)
        success = result.success
        if (!result.success) throw new Error(result.message || "Fulfillment failed")
      }

      await supabase
        .from("fulfillment_queue")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", row.id)

      if (isAuto) await recordAttempt(supabase, row, "sent")
      completed++
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[FULFILLMENT-QUEUE] order ${row.order_id} failed:`, msg)

      await supabase
        .from("fulfillment_queue")
        // No completed_at on failure: the failure time is last_attempted_at (the claim). A tracking failure written during
        // the send must stay newer than this vaguer queue event, or the auto-fulfil policy cannot classify the refusal.
        .update({ status: "failed", error_message: msg })
        .eq("id", row.id)

      if (isAuto) {
        let outcome: AttemptOutcome = "skipped"
        if (sendAttempted) {
          // A held / outcome-unknown send leaves the order off `pending`; an unreadable status is not a known refusal.
          const backToPending = held ? false : await orderLeftPending(supabase, row)
          outcome = backToPending === false ? "held" : backToPending === null ? "unclassified" : failureOutcome(msg)
        }
        await recordAttempt(supabase, row, outcome)
      }

      failed++
    }
  }

  return { claimed: claimed.length, completed, failed, reset_stale: resetRows?.length ?? 0, requeued }
}

/**
 * After a failed auto send: is the order back at `pending` (a clean refusal)? false = it moved on (held / outcome
 * unknown / processing), null = unreadable. Never throws.
 */
async function orderLeftPending(supabase: SupabaseClient, row: QueueRow): Promise<boolean | null> {
  try {
    const source = ORDER_TABLES[row.order_type as OrderType]
    if (!source) return null
    const { data, error } = await supabase.from(source.table).select(source.statusCol).eq("id", row.order_id).maybeSingle()
    if (error || !data) return null
    return String((data as any)[source.statusCol] ?? "").trim().toLowerCase() === "pending"
  } catch {
    return null
  }
}
