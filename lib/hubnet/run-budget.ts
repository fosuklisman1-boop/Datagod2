// Per-cron-run cap on Hubnet status lookups.
//
// Live 2026-11-21: Hubnet allows roughly 10 quick status checks before a 429 with a 25-60s
// wait, and that same allowance is what new orders need for their pre-place lookup. Each
// cron run therefore spends at most a few lookups, and stops spending the moment Hubnet
// pushes back, so placements are not starved.

import type { HubnetClient } from "./client"
import type { StatusLookup } from "./core"

/** Lookups one cron run may spend across all of its phases. */
export const HUBNET_CRON_LOOKUP_BUDGET = 8

export interface LookupBudget {
  /** Claim one lookup. False once the budget is spent or Hubnet has rate-limited us this run. */
  take(): boolean
  /** Record a lookup result; a rate_limited reply ends the run's budget. */
  note(result: StatusLookup): void
  readonly left: number
  readonly stopped: boolean
}

export function lookupBudget(n: number = HUBNET_CRON_LOOKUP_BUDGET): LookupBudget {
  let left = Math.max(0, Math.floor(n))
  let stopped = false
  return {
    take() {
      if (stopped || left <= 0) return false
      left--
      return true
    },
    note(result) {
      if (result.kind === "rate_limited") {
        stopped = true
        left = 0
      }
    },
    get left() { return left },
    get stopped() { return stopped },
  }
}

/**
 * A client whose getStatus draws from `budget`. Once it is spent the wrapper answers
 * rate_limited itself (no network), which every caller already treats as "skip, do not act".
 */
export function budgetedClient<T extends Pick<HubnetClient, "getStatus">>(client: T, budget: LookupBudget): T {
  return {
    ...client,
    async getStatus(reference: string): Promise<StatusLookup> {
      if (!budget.take()) return { kind: "rate_limited", retryAfterSec: 0 }
      const r = await client.getStatus(reference)
      budget.note(r)
      return r
    },
  }
}

/**
 * Rotating window: which `take` of `items` this run looks at, so a long backlog is
 * covered over successive runs instead of always re-checking the oldest rows.
 */
export function rotatingSlice<T>(items: readonly T[], take: number, runIndex: number): T[] {
  if (items.length <= take) return [...items]
  const start = ((runIndex * take) % items.length + items.length) % items.length
  const out: T[] = []
  for (let i = 0; i < take; i++) out.push(items[(start + i) % items.length])
  return out
}
