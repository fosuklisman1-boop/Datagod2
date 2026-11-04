// lib/hubtel-pay/sweep.ts
// The 5-minute backstop for Hubtel payments (route: app/api/cron/hubtel-payments-sweep). Picks rows a callback
// never settled and runs each through confirmHubtelPayment, one at a time. All money decisions stay in confirm.ts
// (atomic claim, status check only); this file only chooses which references to look at.
import type { SupabaseClient } from "@supabase/supabase-js"
import type { ConfirmOutcome } from "./confirm"

export const SWEEP_LIMIT = 50
/** A pending row gets this long for its callback before the sweep checks it. */
export const PENDING_GRACE_MS = 5 * 60_000
/** Matches confirm.ts / claim_hubtel_payment (0152): a confirming claim older than this may be reclaimed. */
export const STALE_CLAIM_MS = 10 * 60_000

export interface DueRow { reference: string; status: string; created_at: string }

/**
 * Up to SWEEP_LIMIT rows, oldest created first: `pending` created more than 5 minutes ago, or `confirming` claimed
 * more than 10 minutes ago. Two simple queries (each already capped) merged, rather than a PostgREST `or` filter.
 * Throws on a database error.
 */
export async function listDueHubtelPayments(sb: SupabaseClient, now: Date, limit = SWEEP_LIMIT): Promise<DueRow[]> {
  const pendingBefore = new Date(now.getTime() - PENDING_GRACE_MS).toISOString()
  const claimedBefore = new Date(now.getTime() - STALE_CLAIM_MS).toISOString()
  const cols = "reference, status, created_at"
  const [pending, stale] = await Promise.all([
    sb.from("hubtel_payments").select(cols).eq("status", "pending").lt("created_at", pendingBefore)
      .order("created_at", { ascending: true }).limit(limit),
    sb.from("hubtel_payments").select(cols).eq("status", "confirming").lt("claimed_at", claimedBefore)
      .order("created_at", { ascending: true }).limit(limit),
  ])
  for (const r of [pending, stale]) {
    if (r.error) throw new Error(`hubtel_payments sweep query failed: ${r.error.message}`)
  }
  const rows = [...((pending.data ?? []) as DueRow[]), ...((stale.data ?? []) as DueRow[])]
  rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
  return rows.slice(0, limit)
}

export type SweepOutcomes = Record<ConfirmOutcome | "error", number>
export interface SweepResult { processed: number; outcomes: SweepOutcomes }

export interface SweepDeps {
  listDue: (now: Date) => Promise<DueRow[]>
  confirm: (reference: string) => Promise<ConfirmOutcome>
  now: () => Date
}

/** Sequential on purpose: each confirm makes a relay status call; one row's throw never stops the rest. */
export async function runHubtelPaymentsSweep(deps: SweepDeps): Promise<SweepResult> {
  const outcomes: SweepOutcomes = { fulfilled: 0, failed: 0, pending: 0, needs_review: 0, ignored: 0, error: 0 }
  const rows = await deps.listDue(deps.now())
  for (const row of rows) {
    try {
      const o = await deps.confirm(row.reference)
      outcomes[o in outcomes ? o : "error"]++
    } catch (e) {
      console.error("[HUBTEL-PAYMENTS-SWEEP] confirm failed for ref", row.reference, e instanceof Error ? e.message : "unknown error")
      outcomes.error++
    }
  }
  return { processed: rows.length, outcomes }
}
