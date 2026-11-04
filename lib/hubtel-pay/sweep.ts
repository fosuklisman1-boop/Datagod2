// lib/hubtel-pay/sweep.ts
// The 5-minute backstop for Hubtel payments (route: app/api/cron/hubtel-payments-sweep). Picks rows a callback
// never settled and runs each through confirmHubtelPayment, one at a time. All money decisions stay in confirm.ts
// (atomic claim, status check only); this file only chooses which references to look at.
import type { SupabaseClient } from "@supabase/supabase-js"
import type { ConfirmOutcome } from "./confirm"

export const SWEEP_LIMIT = 50
/** A pending row gets this long for its callback before the sweep checks it. */
export const PENDING_GRACE_MS = 5 * 60_000
/**
 * Matches confirm.ts / claim_hubtel_payment (0152): a confirming claim older than this may be reclaimed.
 * This sweep uses the app clock and the RPC the DB clock; skew only causes an "ignored" (the row waits for the next run).
 */
export const STALE_CLAIM_MS = 10 * 60_000
/** Stop starting new rows after this long, well inside the route's maxDuration of 120s. */
export const SWEEP_DEADLINE_MS = 85_000

export interface DueRow { reference: string; status: string; updated_at: string }

/**
 * Up to SWEEP_LIMIT rows, least recently checked first: `pending` created more than 5 minutes ago, or `confirming`
 * claimed more than 10 minutes ago. Ordered by updated_at, not created_at: every check stamps updated_at, so rows that
 * never resolve take turns instead of filling every run ahead of newer payments.
 * Two simple queries (each already capped) merged, rather than a PostgREST `or` filter. Throws on a database error.
 */
export async function listDueHubtelPayments(sb: SupabaseClient, now: Date, limit = SWEEP_LIMIT): Promise<DueRow[]> {
  const pendingBefore = new Date(now.getTime() - PENDING_GRACE_MS).toISOString()
  const claimedBefore = new Date(now.getTime() - STALE_CLAIM_MS).toISOString()
  const cols = "reference, status, updated_at"
  const [pending, stale] = await Promise.all([
    sb.from("hubtel_payments").select(cols).eq("status", "pending").lt("created_at", pendingBefore)
      .order("updated_at", { ascending: true }).limit(limit),
    sb.from("hubtel_payments").select(cols).eq("status", "confirming").lt("claimed_at", claimedBefore)
      .order("updated_at", { ascending: true }).limit(limit),
  ])
  for (const r of [pending, stale]) {
    if (r.error) throw new Error(`hubtel_payments sweep query failed: ${r.error.message}`)
  }
  const rows = [...((pending.data ?? []) as DueRow[]), ...((stale.data ?? []) as DueRow[])]
  rows.sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime())
  return rows.slice(0, limit)
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
}

/** Sequential on purpose: each confirm makes a relay status call; one row's throw never stops the rest. */
export async function runHubtelPaymentsSweep(deps: SweepDeps): Promise<SweepResult> {
  const outcomes: SweepOutcomes = { fulfilled: 0, failed: 0, pending: 0, needs_review: 0, ignored: 0, error: 0 }
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
