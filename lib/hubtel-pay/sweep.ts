// lib/hubtel-pay/sweep.ts
// The 5-minute backstop for Hubtel payments (route: app/api/cron/hubtel-payments-sweep). Picks rows a callback
// never settled and runs each through confirmHubtelPayment, one at a time. All money decisions stay in confirm.ts
// (atomic claim, status check only); this file only chooses which references to look at.
import type { SupabaseClient } from "@supabase/supabase-js"
import { sendThrottledAlert } from "./alert-throttle"
import type { ConfirmOutcome } from "./confirm"

export const SWEEP_LIMIT = 50
/** A pending row gets this long for its callback before the sweep checks it. */
export const PENDING_GRACE_MS = 5 * 60_000
/**
 * Matches confirm.ts / claim_hubtel_payment (0152): a confirming claim older than this may be reclaimed.
 * This sweep uses the app clock and the RPC the DB clock; skew only causes an "ignored" (the row waits for the next run).
 */
export const STALE_CLAIM_MS = 10 * 60_000
/** Stop starting new rows after this long, well inside the route's maxDuration of 180s. */
export const SWEEP_DEADLINE_MS = 85_000
/** A `failed` row is checked for a late payment while younger than this. Matches confirm.ts. */
export const LATE_PAYMENT_WINDOW_MS = 72 * 60 * 60_000
/** ...and at most this often: every check of a failed row stamps updated_at. */
export const LATE_PAYMENT_RECHECK_MS = 60 * 60_000
/** At most one sweep failure alert per this long, across all instances. */
export const SWEEP_ALERT_WINDOW_MS = 60 * 60_000
const SWEEP_ALERT_KEY = "last_hubtel_payments_sweep_alert"
/** Distinct type so muting per-payment "hubtel_payment" alerts cannot silence this one. */
const SWEEP_ALERT_TYPE = "hubtel_payments_sweep"

export interface DueRow { reference: string; status: string; updated_at: string }

/**
 * Up to SWEEP_LIMIT rows, least recently checked first: `pending` created more than 5 minutes ago, `confirming`
 * claimed more than 10 minutes ago, or `failed` under 72 hours old, not checked for over an hour
 * and with no refused_at (late payments; a refused attempt never reached Hubtel, so there is nothing to check).
 * Ordered by updated_at, not created_at: every check stamps updated_at, so rows that never resolve take turns instead
 * of filling every run ahead of newer payments.
 * Three simple queries (each already capped) merged, rather than a PostgREST `or` filter. Throws on a database error.
 */
export async function listDueHubtelPayments(sb: SupabaseClient, now: Date, limit = SWEEP_LIMIT): Promise<DueRow[]> {
  const pendingBefore = new Date(now.getTime() - PENDING_GRACE_MS).toISOString()
  const claimedBefore = new Date(now.getTime() - STALE_CLAIM_MS).toISOString()
  const failedAfter = new Date(now.getTime() - LATE_PAYMENT_WINDOW_MS).toISOString()
  const failedCheckedBefore = new Date(now.getTime() - LATE_PAYMENT_RECHECK_MS).toISOString()
  const cols = "reference, status, updated_at"
  const [pending, stale, failed] = await Promise.all([
    sb.from("hubtel_payments").select(cols).eq("status", "pending").lt("created_at", pendingBefore)
      .order("updated_at", { ascending: true }).limit(limit),
    sb.from("hubtel_payments").select(cols).eq("status", "confirming").lt("claimed_at", claimedBefore)
      .order("updated_at", { ascending: true }).limit(limit),
    sb.from("hubtel_payments").select(cols).eq("status", "failed").is("refused_at", null).gt("created_at", failedAfter).lt("updated_at", failedCheckedBefore)
      .order("updated_at", { ascending: true }).limit(limit),
  ])
  for (const r of [pending, stale, failed]) {
    if (r.error) throw new Error(`hubtel_payments sweep query failed: ${r.error.message}`)
  }
  const rows = [pending, stale, failed].flatMap((r) => (r.data ?? []) as DueRow[])
  rows.sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime())
  return rows.slice(0, limit)
}

/** One notifyAdmins per SWEEP_ALERT_WINDOW_MS across instances; see sendThrottledAlert. Never throws. */
export async function sendSweepAlert(
  db: SupabaseClient, message: string,
  opts: { notify?: (message: string, type: string) => Promise<void>; now?: () => Date } = {},
): Promise<void> {
  await sendThrottledAlert(db, message, {
    key: SWEEP_ALERT_KEY, type: SWEEP_ALERT_TYPE, description: "Hubtel payments sweep alert throttle",
    windowMs: SWEEP_ALERT_WINDOW_MS, logPrefix: "[HUBTEL-PAYMENTS-SWEEP]", ...opts,
  })
}

export type SweepOutcomes = Record<ConfirmOutcome | "error", number>
/** processed: rows a confirm was started for. skipped: rows the time budget did not reach (next run picks them up). */
export interface SweepResult { processed: number; skipped: number; outcomes: SweepOutcomes }

export interface SweepDeps {
  listDue: (now: Date) => Promise<DueRow[]>
  confirm: (reference: string) => Promise<ConfirmOutcome>
  now: () => Date
  /** Stop starting new rows once this much time has passed since the sweep began. Default SWEEP_DEADLINE_MS. */
  deadlineMs?: number
  /** Told about a run with row errors, or one that threw. Messages hold counts only (no references, no error text). */
  alert?: (message: string) => Promise<void>
}

/** Alerts decide nothing and must never stop a sweep. */
async function tellAdmins(deps: SweepDeps, message: string): Promise<void> {
  try {
    await deps.alert?.(message)
  } catch (e) {
    console.error("[HUBTEL-PAYMENTS-SWEEP] alert failed:", e instanceof Error ? e.message : "unknown error")
  }
}

/** Runs the sweep and tells admins (throttled by deps.alert) when it hit errors. Rethrows whatever the run threw. */
export async function runHubtelPaymentsSweep(deps: SweepDeps): Promise<SweepResult> {
  let result: SweepResult
  try {
    result = await sweepRows(deps)
  } catch (e) {
    await tellAdmins(deps, "Hubtel payments sweep could not run; open payments are not being checked. See the [HUBTEL-PAYMENTS-SWEEP] logs.")
    throw e
  }
  const errors = result.outcomes.error + result.outcomes.check_error
  if (errors > 0) {
    await tellAdmins(deps, `Hubtel payments sweep: ${errors} of ${result.processed} payments could not be checked this run. See the [HUBTEL-PAYMENTS-SWEEP] logs.`)
  }
  return result
}

/** Sequential on purpose: each confirm makes a relay status call; one row's throw never stops the rest. */
async function sweepRows(deps: SweepDeps): Promise<SweepResult> {
  const outcomes: SweepOutcomes = { fulfilled: 0, failed: 0, pending: 0, check_error: 0, needs_review: 0, ignored: 0, error: 0 }
  const deadlineMs = deps.deadlineMs ?? SWEEP_DEADLINE_MS
  const started = deps.now()
  const rows = await deps.listDue(started)
  let processed = 0
  for (const row of rows) {
    if (deps.now().getTime() - started.getTime() >= deadlineMs) break
    processed++
    try {
      const o = await deps.confirm(row.reference)
      outcomes[Object.hasOwn(outcomes, o) ? o : "error"]++
    } catch (e) {
      console.error("[HUBTEL-PAYMENTS-SWEEP] confirm failed for ref", row.reference, e instanceof Error ? e.message : "unknown error")
      outcomes.error++
    }
  }
  return { processed, skipped: rows.length - processed, outcomes }
}
