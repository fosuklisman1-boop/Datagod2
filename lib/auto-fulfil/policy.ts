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

export type CandidateFacts = {
  verdict: Verdict
  everHeldOrReversed: boolean
  failure: LatestFailure
  autoTries: number
  blacklisted: boolean
  networkSwitchOn: boolean
}

export type Decision =
  | { kind: "queue" }
  | { kind: "wait"; until: string }
  | { kind: "needs_you"; reason: string }
  | { kind: "skip"; reason: string }

/** Queue messages the drain writes itself when it skips a job without ever calling a supplier. */
export function isNonSendQueueMessage(message: string | null): boolean {
  const m = (message ?? "").trim()
  return m === "auto-fulfil switched off" || m.startsWith("order no longer pending") || m === "order status unreadable"
}

function bucketOf(e: FailureEvent): NonNullable<LatestFailure>["bucket"] | null {
  if (e.source === "tracking") {
    const r = classifyFailureReason({ status: e.status, mtnOrderId: e.mtnOrderId, message: e.message })
    return r === "none" ? null : r
  }
  if (e.status !== "failed" || isNonSendQueueMessage(e.message)) return null
  // A queue message alone is not proof of a definite supplier refusal, so no keyword => unclassified.
  const r = classifyMessage(e.message)
  return r === null || r === "none" ? "unclassified" : r
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

  const failure = f.failure
  if (!failure) return { kind: "queue" }
  if (failure.bucket === "outcome_unknown") return { kind: "needs_you", reason: "outcome_unknown" }
  if (failure.bucket === "unclassified") return { kind: "needs_you", reason: "unclassified" }

  const rule = s.rules[failure.bucket]
  if (!rule.retry) return { kind: "needs_you", reason: failure.bucket }
  if (f.autoTries >= rule.maxTries) return { kind: "needs_you", reason: "out_of_tries" }

  const until = new Date(Date.parse(failure.at) + rule.waitMinutes * 60_000)
  if (now.getTime() < until.getTime()) return { kind: "wait", until: until.toISOString() }
  return { kind: "queue" }
}
