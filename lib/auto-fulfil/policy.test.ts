import { describe, it, expect } from "vitest"
import {
  decideCandidate,
  isNonSendQueueMessage,
  latestFailure,
  NON_SEND_NOT_PENDING_PREFIX,
  NON_SEND_SWITCHED_OFF,
  NON_SEND_UNREADABLE,
  type CandidateFacts,
  type FailureEvent,
} from "./policy"
import { DEFAULT_AUTO_FULFIL_SETTINGS, type AutoFulfilSettings } from "./settings"

const NOW = new Date("2026-11-22T12:00:00.000Z")
const iso = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString()

// Enabled copy; never mutate the shared default (or its nested rules).
const S: AutoFulfilSettings = {
  ...DEFAULT_AUTO_FULFIL_SETTINGS,
  enabled: true,
  rules: { ...DEFAULT_AUTO_FULFIL_SETTINGS.rules },
}

const facts = (over: Partial<CandidateFacts> = {}): CandidateFacts => ({
  verdict: { kind: "eligible" },
  everHeldOrReversed: false,
  failure: null,
  autoTries: 0,
  blacklisted: false,
  networkSwitchOn: true,
  ...over,
})

const tracking = (at: string, status: string | null, message: string | null = null, mtnOrderId: string | null = null): FailureEvent => ({
  at,
  source: "tracking",
  status,
  mtnOrderId,
  message,
})
const queue = (at: string, status: string | null, message: string | null = null): FailureEvent => ({
  at,
  source: "queue",
  status,
  mtnOrderId: null,
  message,
})

describe("latestFailure", () => {
  it("no events => null", () => {
    expect(latestFailure([])).toBeNull()
  })

  it("tracking row abandoned newer than a failed one => outcome_unknown", () => {
    expect(
      latestFailure([
        tracking(iso(-30), "failed", "Insufficient balance"),
        tracking(iso(-10), "abandoned"),
      ]),
    ).toEqual({ bucket: "outcome_unknown", at: iso(-10) })
  })

  it("UNKNOWN_ mtn order id => outcome_unknown", () => {
    expect(latestFailure([tracking(iso(-5), "processing", null, "UNKNOWN_123")])).toEqual({
      bucket: "outcome_unknown",
      at: iso(-5),
    })
  })

  it("newest failure wins regardless of input order", () => {
    expect(
      latestFailure([
        tracking(iso(-5), "failed", "rate limit exceeded"),
        tracking(iso(-50), "failed", "Insufficient balance"),
      ]),
    ).toEqual({ bucket: "rate_limited", at: iso(-5) })
  })

  it("tracking rows that are not failures are ignored", () => {
    expect(
      latestFailure([
        tracking(iso(-50), "failed", "no active bundle"),
        tracking(iso(-5), "completed", null, "MTN-1"),
      ]),
    ).toEqual({ bucket: "no_bundle", at: iso(-50) })
  })

  it("tracking failed with no keyword => rejected", () => {
    expect(latestFailure([tracking(iso(-5), "failed", "something odd")])).toEqual({ bucket: "rejected", at: iso(-5) })
  })

  it("queue message 'Insufficient balance' => out_of_balance; 'socket hang up' => unclassified", () => {
    expect(latestFailure([queue(iso(-5), "failed", "Insufficient balance")])).toEqual({
      bucket: "out_of_balance",
      at: iso(-5),
    })
    expect(latestFailure([queue(iso(-5), "failed", "socket hang up")])).toEqual({
      bucket: "unclassified",
      at: iso(-5),
    })
  })

  it("queue events that are not failed are ignored", () => {
    expect(latestFailure([queue(iso(-5), "done", "Insufficient balance")])).toBeNull()
  })

  describe("queue drain skips that never reached a supplier are ignored", () => {
    for (const msg of ["auto-fulfil switched off", "order no longer pending (processing)", "order status unreadable"]) {
      it(`'${msg}' newest => older real failure wins`, () => {
        expect(
          latestFailure([tracking(iso(-30), "failed", "rate limit hit"), queue(iso(-1), "failed", msg)]),
        ).toEqual({ bucket: "rate_limited", at: iso(-30) })
      })
      it(`'${msg}' alone => null`, () => {
        expect(latestFailure([queue(iso(-1), "failed", msg)])).toBeNull()
      })
    }
  })
})

describe("isNonSendQueueMessage", () => {
  it("exported constants are the drain's exact strings", () => {
    expect(NON_SEND_SWITCHED_OFF).toBe("auto-fulfil switched off")
    expect(NON_SEND_NOT_PENDING_PREFIX).toBe("order no longer pending")
    expect(NON_SEND_UNREADABLE).toBe("order status unreadable")
    expect(isNonSendQueueMessage(`${NON_SEND_NOT_PENDING_PREFIX} (failed)`)).toBe(true)
  })

  it("matches the drain's own skip messages (trimmed)", () => {
    expect(isNonSendQueueMessage("auto-fulfil switched off")).toBe(true)
    expect(isNonSendQueueMessage("  auto-fulfil switched off ")).toBe(true)
    expect(isNonSendQueueMessage("order no longer pending")).toBe(true)
    expect(isNonSendQueueMessage("order no longer pending (completed)")).toBe(true)
    expect(isNonSendQueueMessage("order status unreadable")).toBe(true)
  })
  it("does not match real supplier messages", () => {
    expect(isNonSendQueueMessage(null)).toBe(false)
    expect(isNonSendQueueMessage("")).toBe(false)
    expect(isNonSendQueueMessage("socket hang up")).toBe(false)
    expect(isNonSendQueueMessage("auto-fulfil switched off by supplier")).toBe(false)
    expect(isNonSendQueueMessage("order status unreadable: timeout")).toBe(false)
  })
})

describe("decideCandidate", () => {
  it("never-tried order (no events) is queued", () => {
    expect(decideCandidate(facts({ failure: latestFailure([]) }), S, NOW)).toEqual({ kind: "queue" })
  })

  it("blocked verdict => skip with the blocked reason", () => {
    expect(decideCandidate(facts({ verdict: { kind: "blocked", reason: "live_at_supplier" } }), S, NOW)).toEqual({
      kind: "skip",
      reason: "live_at_supplier",
    })
  })

  it("risky verdict => skip risky", () => {
    expect(decideCandidate(facts({ verdict: { kind: "risky", why: "held" } }), S, NOW)).toEqual({
      kind: "skip",
      reason: "risky",
    })
  })

  it("verdict check comes before blacklisted", () => {
    expect(
      decideCandidate(facts({ verdict: { kind: "blocked", reason: "completed" }, blacklisted: true }), S, NOW),
    ).toEqual({ kind: "skip", reason: "completed" })
  })

  it("blacklisted => skip blacklisted", () => {
    expect(decideCandidate(facts({ blacklisted: true, networkSwitchOn: false }), S, NOW)).toEqual({
      kind: "skip",
      reason: "blacklisted",
    })
  })

  it("network switch off => skip network_switch_off", () => {
    expect(decideCandidate(facts({ networkSwitchOn: false, everHeldOrReversed: true }), S, NOW)).toEqual({
      kind: "skip",
      reason: "network_switch_off",
    })
  })

  it("ever held or reversed => needs_you held_or_reversed_history", () => {
    expect(decideCandidate(facts({ everHeldOrReversed: true }), S, NOW)).toEqual({
      kind: "needs_you",
      reason: "held_or_reversed_history",
    })
  })

  it("outcome_unknown => needs_you outcome_unknown", () => {
    expect(decideCandidate(facts({ failure: { bucket: "outcome_unknown", at: iso(-600) } }), S, NOW)).toEqual({
      kind: "needs_you",
      reason: "outcome_unknown",
    })
  })

  it("unclassified => needs_you unclassified", () => {
    expect(decideCandidate(facts({ failure: { bucket: "unclassified", at: iso(-600) } }), S, NOW)).toEqual({
      kind: "needs_you",
      reason: "unclassified",
    })
  })

  it("bucket whose rule does not retry => needs_you with the bucket name", () => {
    expect(decideCandidate(facts({ failure: { bucket: "wrong_number", at: iso(-600) } }), S, NOW)).toEqual({
      kind: "needs_you",
      reason: "wrong_number",
    })
  })

  it("rejected with 3 auto tries => needs_you out_of_tries", () => {
    expect(
      decideCandidate(facts({ failure: { bucket: "rejected", at: iso(-600) }, autoTries: 3 }), S, NOW),
    ).toEqual({ kind: "needs_you", reason: "out_of_tries" })
  })

  it("rate_limited 1 min ago waits until +2 min", () => {
    expect(decideCandidate(facts({ failure: { bucket: "rate_limited", at: iso(-1) }, autoTries: 1 }), S, NOW)).toEqual({
      kind: "wait",
      until: iso(+1),
    })
  })

  it("exactly at the wait boundary => queue", () => {
    expect(decideCandidate(facts({ failure: { bucket: "rate_limited", at: iso(-2) }, autoTries: 1 }), S, NOW)).toEqual({
      kind: "queue",
    })
  })

  it("admin tries are not counted: autoTries 0 after admin failures => queued once the wait passes", () => {
    const failure = latestFailure([
      tracking(iso(-200), "failed", "something odd"),
      tracking(iso(-120), "failed", "something odd"),
      tracking(iso(-90), "failed", "something odd"),
    ])
    expect(failure).toEqual({ bucket: "rejected", at: iso(-90) })
    expect(decideCandidate(facts({ failure, autoTries: 0 }), S, NOW)).toEqual({ kind: "queue" })
  })

  it("unreadable failure time => needs_you unreadable_failure_time (never skips the wait)", () => {
    const failure = latestFailure([tracking("not-a-date", "failed", "rate limit exceeded")])
    expect(failure).toEqual({ bucket: "rate_limited", at: "not-a-date" })
    expect(decideCandidate(facts({ failure, autoTries: 1 }), S, NOW)).toEqual({
      kind: "needs_you",
      reason: "unreadable_failure_time",
    })
  })

  it("no failure record but an earlier auto send => needs_you unaccounted_auto_send", () => {
    expect(decideCandidate(facts({ failure: null, autoTries: 1 }), S, NOW)).toEqual({
      kind: "needs_you",
      reason: "unaccounted_auto_send",
    })
  })

  it("no failure record and no auto sends => queue", () => {
    expect(decideCandidate(facts({ failure: null, autoTries: 0 }), S, NOW)).toEqual({ kind: "queue" })
  })

  it("uses the settings' rules, not the defaults", () => {
    const custom: AutoFulfilSettings = {
      ...S,
      rules: { ...S.rules, wrong_number: { retry: true, waitMinutes: 5, maxTries: 2 } },
    }
    expect(
      decideCandidate(facts({ failure: { bucket: "wrong_number", at: iso(-10) }, autoTries: 1 }), custom, NOW),
    ).toEqual({ kind: "queue" })
  })
})
