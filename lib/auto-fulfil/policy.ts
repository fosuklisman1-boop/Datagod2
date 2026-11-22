import type { Verdict } from "@/lib/order-queue/eligibility"
import { classifyFailureReason, classifyMessage } from "@/lib/order-queue/failure-reason"
import type { AutoFulfilSettings, RetryBucket } from "./settings"

export type FailureEvent = {
  at: string
  source: "tracking" | "queue"
  status: string | null
  mtnOrderId: string | null
  message: string | null
}

export type LatestFailure = { bucket: RetryBucket | "unclassified" | "outcome_unknown"; at: string } | null

/** order_dispatch_claims: last_outcome ('claimed' | 'submitted' | 'unknown' | 'failed') and updated_at as an ISO string. */
export type DispatchClaim = { outcome: string | null; updatedAt: string | null }

export type CandidateFacts = {
  verdict: Verdict
  everHeldOrReversed: boolean
  failure: LatestFailure
  autoTries: number
  /** Automatic attempts that ended 'skipped' (never sent). */
  autoSkips: number
  /** The order's row in order_dispatch_claims (what the dispatcher last recorded), or null when it has none. */
  claim: DispatchClaim | null
  blacklisted: boolean
  networkSwitchOn: boolean
}

export type Decision =
  | { kind: "queue" }
  | { kind: "wait"; until: string }
  | { kind: "needs_you"; reason: string }
  | { kind: "skip"; reason: string }

/** An order the drain skipped this many times without sending goes to a person (no endless queue/skip loop). */
export const MAX_AUTO_SKIPS = 10

// Queue messages the drain writes itself when it skips a job without ever calling a supplier.
export const NON_SEND_SWITCHED_OFF = "auto-fulfil switched off"
export const NON_SEND_NOT_PENDING_PREFIX = "order no longer pending"
export const NON_SEND_UNREADABLE = "order status unreadable"

export function isNonSendQueueMessage(message: string | null): boolean {
  const m = (message ?? "").trim()
  return m === NON_SEND_SWITCHED_OFF || m.startsWith(NON_SEND_NOT_PENDING_PREFIX) || m === NON_SEND_UNREADABLE
}

function bucketOf(e: FailureEvent): NonNullable<LatestFailure>["bucket"] | null {
  if (e.source === "tracking") {
    const r = classifyFailureReason({ status: e.status, mtnOrderId: e.mtnOrderId, message: e.message })
    return r === "none" ? null : r
  }
  if (e.status !== "failed" || isNonSendQueueMessage(e.message)) return null
  // A queue message alone is not proof of a definite supplier refusal, so no keyword => unclassified.
  // The keyword rules only ever yield retry buckets (never "none", "rejected" or "outcome_unknown").
  const r = classifyMessage(e.message) as RetryBucket | null
  return r ?? "unclassified"
}

const timeOf = (at: string) => {
  const t = Date.parse(at)
  return Number.isNaN(t) ? -Infinity : t
}

/** The newest event that is a failure, or null when none is. */
export function latestFailure(events: FailureEvent[]): LatestFailure {
  const newestFirst = [...events].sort((a, b) => timeOf(b.at) - timeOf(a.at))
  for (const e of newestFirst) {
    const bucket = bucketOf(e)
    if (bucket) return { bucket, at: e.at }
  }
  return null
}

/** What the cron does with one candidate order. First match wins. Pure. */
export function decideCandidate(f: CandidateFacts, s: AutoFulfilSettings, now: Date): Decision {
  if (f.verdict.kind === "blocked") return { kind: "skip", reason: f.verdict.reason }
  if (f.verdict.kind !== "eligible") return { kind: "skip", reason: "risky" }
  if (f.blacklisted) return { kind: "skip", reason: "blacklisted" }
  if (!f.networkSwitchOn) return { kind: "skip", reason: "network_switch_off" }
  if (f.everHeldOrReversed) return { kind: "needs_you", reason: "held_or_reversed_history" }
  if (f.autoSkips >= MAX_AUTO_SKIPS) return { kind: "needs_you", reason: "repeatedly_skipped" }

  // The dispatcher's own record. A claim with no recorded failure may mean the order reached a supplier although our
  // tracking write was lost, so it must never look "never tried". 'failed' and no claim change nothing; 'submitted'
  // alone is normal after a refused send (the failure is recorded afterwards), so it only needs a failure at or after it.
  const claim = f.claim
  if (claim && claim.outcome !== "failed") {
    if (claim.outcome !== "submitted") return { kind: "needs_you", reason: "dispatch_outcome_unknown" }
    const claimAt = claim.updatedAt ? Date.parse(claim.updatedAt) : NaN
    const failAt = f.failure ? Date.parse(f.failure.at) : NaN
    if (Number.isNaN(claimAt) || Number.isNaN(failAt) || failAt < claimAt) return { kind: "needs_you", reason: "submitted_without_failure" }
  }

  const failure = f.failure
  if (!failure) {
    // An earlier automatic send left no failure record: we cannot tell whether it was created, so never send twice.
    return f.autoTries > 0 ? { kind: "needs_you", reason: "unaccounted_auto_send" } : { kind: "queue" }
  }
  if (failure.bucket === "outcome_unknown") return { kind: "needs_you", reason: "outcome_unknown" }
  if (failure.bucket === "unclassified") return { kind: "needs_you", reason: "unclassified" }

  const rule = s.rules[failure.bucket]
  if (!rule.retry) return { kind: "needs_you", reason: failure.bucket }
  if (f.autoTries >= rule.maxTries) return { kind: "needs_you", reason: "out_of_tries" }

  const failedAt = Date.parse(failure.at)
  // Fail closed: without a readable failure time the wait cannot be honoured.
  if (Number.isNaN(failedAt)) return { kind: "needs_you", reason: "unreadable_failure_time" }
  const until = new Date(failedAt + rule.waitMinutes * 60_000)
  if (now.getTime() < until.getTime()) return { kind: "wait", until: until.toISOString() }
  return { kind: "queue" }
}
