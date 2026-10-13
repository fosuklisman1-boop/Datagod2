import { describe, it, expect } from "vitest"
import {
  applyCallback, applyPostResponse, applyResolve, applyStatusCheck, classifyCode, parseCommission, sweepStale,
} from "./state-machine"
import { makeTx, minutesAfter, T0 } from "./testing/fixtures"
import type { ParsedCallback } from "./types"

const cb = (over: Partial<ParsedCallback> = {}): ParsedCallback => ({
  responseCode: "0000", clientReference: "HCS-airtime_mtn-TESTREF1", transactionId: "hub-1",
  externalTransactionId: "ext-1", description: "ok", amountDebited: 5, charges: 0, commission: 0.0198, ...over,
})
const next = (t: any) => { expect("next" in t).toBe(true); return t as Extract<typeof t, { next: any }> }

describe("classifyCode / parseCommission", () => {
  it("classifies Hubtel codes", () => {
    expect(classifyCode("0000")).toBe("success")
    expect(classifyCode("0001")).toBe("pending")
    expect(classifyCode("0005")).toBe("unknown")
    expect(classifyCode(undefined)).toBe("unknown")
    expect(classifyCode("4075")).toBe("float")
    expect(classifyCode("2001")).toBe("failed")
    expect(classifyCode("4010")).toBe("failed")
  })
  it("parses commission strings", () => {
    expect(parseCommission("0.0198")).toBe(0.0198)
    expect(parseCommission(" 0.35 ")).toBe(0.35)
    expect(parseCommission("0.0000")).toBe(0)
    expect(parseCommission(null)).toBeNull()
    expect(parseCommission("")).toBeNull()
    expect(parseCommission("   ")).toBeNull()
    expect(parseCommission("abc")).toBeNull()
    expect(parseCommission("-1")).toBeNull()
  })
})

describe("applyPostResponse", () => {
  const ok = { httpStatus: 200, body: { ResponseCode: "0001", Message: "Transaction pending.", Data: { TransactionId: " abc123 ", Meta: { Commission: "0.0198" } } } }

  it("0001 -> pending, stores trimmed transaction id and commission", () => {
    const t = next(applyPostResponse(makeTx(), ok, T0))
    expect(t.next).toBe("pending")
    expect(t.patch.hubtel_transaction_id).toBe("abc123")
    expect(t.patch.commission).toBe(0.0198)
    expect(t.patch.submitted_at).toBe(T0.toISOString())
  })
  it("0000 -> fulfilled", () => {
    const t = next(applyPostResponse(makeTx(), { httpStatus: 200, body: { ResponseCode: "0000", Data: {} } }, T0))
    expect(t.next).toBe("fulfilled")
    expect(t.patch.completed_at).toBeTruthy()
  })
  it("4075 -> failed and flags float", () => {
    const t = next(applyPostResponse(makeTx(), { httpStatus: 200, body: { ResponseCode: "4075", Message: "Insufficient prepaid balance." } }, T0))
    expect(t.next).toBe("failed")
    expect(t.float).toBe(true)
    expect(t.patch.failure_reason).toMatch(/prepaid balance/i)
  })
  it("definite error codes -> failed with Hubtel's message", () => {
    const t = next(applyPostResponse(makeTx(), { httpStatus: 400, body: { ResponseCode: "4010", Message: "Validation errors" } }, T0))
    expect(t.next).toBe("failed")
    expect(t.patch.failure_reason).toBe("Validation errors")
  })
  it("0005 -> needs_review (state unknown)", () => {
    const t = next(applyPostResponse(makeTx(), { httpStatus: 200, body: { ResponseCode: "0005", Message: "HTTP failure" } }, T0))
    expect(t.next).toBe("needs_review")
    expect(t.patch.review_reason).toMatch(/do not resend/i)
  })
  it("transport error -> needs_review", () => {
    const t = next(applyPostResponse(makeTx(), { error: "timeout" }, T0))
    expect(t.next).toBe("needs_review")
    expect(t.patch.review_reason).toMatch(/timeout/)
  })
  it("no ResponseCode (html / 5xx body) -> needs_review, NOT failed", () => {
    const t = next(applyPostResponse(makeTx(), { httpStatus: 502, body: "<html>Bad gateway</html>" }, T0))
    expect(t.next).toBe("needs_review")
  })
  it("ignores a row that is not in created", () => {
    expect(applyPostResponse(makeTx({ state: "pending" }), ok, T0)).toEqual({ ignored: "state is pending" })
  })
})

describe("applyCallback", () => {
  it("0000 on a pending row -> fulfilled with ids, charges and commission", () => {
    const t = next(applyCallback(makeTx({ state: "pending" }), cb(), T0))
    expect(t.next).toBe("fulfilled")
    expect(t.patch.external_transaction_id).toBe("ext-1")
    expect(t.patch.commission).toBe(0.0198)
    expect(t.patch.callback_received_at).toBe(T0.toISOString())
  })
  it("a blank Meta.Commission callback preserves the stored commission", () => {
    const t = next(applyCallback(makeTx({ state: "pending", commission: 0.5 }), cb({ commission: parseCommission("  ") }), T0))
    expect(t.patch.commission).toBe(0.5)
  })
  it("non-0000 -> failed with the Description as reason", () => {
    const t = next(applyCallback(makeTx({ state: "pending" }), cb({ responseCode: "2001", description: "The receiving user is not registered" }), T0))
    expect(t.next).toBe("failed")
    expect(t.patch.failure_reason).toBe("The receiving user is not registered")
  })
  it("0005 in a callback -> needs_review", () => {
    expect(next(applyCallback(makeTx({ state: "pending" }), cb({ responseCode: "0005" }), T0)).next).toBe("needs_review")
  })
  it("a terminal row ignores late/duplicate callbacks", () => {
    expect(applyCallback(makeTx({ state: "fulfilled" }), cb({ responseCode: "2001" }), T0)).toEqual({ ignored: "already fulfilled" })
    expect(applyCallback(makeTx({ state: "failed" }), cb(), T0)).toEqual({ ignored: "already failed" })
  })
  it("a row resolved by an admin ignores callbacks", () => {
    expect(applyCallback(makeTx({ state: "needs_review", resolved_at: T0.toISOString() }), cb(), T0)).toEqual({ ignored: "resolved by admin" })
  })
  it("an unresolved needs_review row can still be settled by a callback", () => {
    expect(next(applyCallback(makeTx({ state: "needs_review" }), cb(), T0)).next).toBe("fulfilled")
  })
  it("an interim 0001 callback is ignored", () => {
    expect(applyCallback(makeTx({ state: "pending" }), cb({ responseCode: "0001" }), T0)).toEqual({ ignored: "interim 0001 callback" })
  })
})

describe("applyStatusCheck", () => {
  const pending = (over = {}) => makeTx({ state: "pending", submitted_at: T0.toISOString(), ...over })

  it("Paid + isFulfilled=true -> fulfilled", () => {
    const t = next(applyStatusCheck(pending(), { ok: true, status: "Paid", isFulfilled: true }, minutesAfter(6)))
    expect(t.next).toBe("fulfilled")
    expect(t.patch.status_check_attempts).toBe(1)
  })
  it("a single negative observation never fails the row", () => {
    const t = next(applyStatusCheck(pending(), { ok: true, status: "Unpaid", isFulfilled: false }, minutesAfter(12)))
    expect(t.next).toBe("pending")
    expect(t.patch.negative_checks).toBe(1)
  })
  it("second consecutive negative after 10 min -> failed", () => {
    const t = next(applyStatusCheck(pending({ negative_checks: 1 }), { ok: true, status: "Unpaid", isFulfilled: false }, minutesAfter(12)))
    expect(t.next).toBe("failed")
    expect(t.patch.failure_reason).toMatch(/not fulfilled/i)
  })
  it("second negative before 10 min stays pending", () => {
    const t = next(applyStatusCheck(pending({ negative_checks: 1 }), { ok: true, status: "Unpaid", isFulfilled: false }, minutesAfter(6)))
    expect(t.next).toBe("pending")
    expect(t.patch.negative_checks).toBe(2)
  })
  it("isFulfilled null resets the negative counter and keeps polling", () => {
    const t = next(applyStatusCheck(pending({ negative_checks: 1 }), { ok: true, status: "Paid", isFulfilled: null }, minutesAfter(12)))
    expect(t.next).toBe("pending")
    expect(t.patch.negative_checks).toBe(0)
  })
  it("a failed check call only bumps attempts", () => {
    const t = next(applyStatusCheck(pending(), { ok: false }, minutesAfter(6)))
    expect(t.next).toBe("pending")
    expect(t.patch.status_check_attempts).toBe(1)
    expect(t.patch.negative_checks).toBeUndefined()
  })
  it("pending older than 24h -> needs_review", () => {
    const t = next(applyStatusCheck(pending(), { ok: true, status: "Paid", isFulfilled: null }, minutesAfter(24 * 60 + 1)))
    expect(t.next).toBe("needs_review")
  })
  it("ignores fulfilled / failed rows and admin-resolved rows", () => {
    expect("ignored" in applyStatusCheck(makeTx({ state: "fulfilled" }), { ok: true }, T0)).toBe(true)
    expect("ignored" in applyStatusCheck(makeTx({ state: "needs_review", resolved_at: T0.toISOString() }), { ok: true }, T0)).toBe(true)
  })
})

describe("sweepStale", () => {
  it("created older than 2 minutes -> needs_review", () => {
    expect(next(sweepStale(makeTx({ state: "created" }), minutesAfter(3))).next).toBe("needs_review")
  })
  it("created younger than 2 minutes is left alone", () => {
    expect(sweepStale(makeTx({ state: "created" }), minutesAfter(1))).toEqual({ ignored: "not stale" })
  })
  it("pending older than 24h -> needs_review", () => {
    expect(next(sweepStale(makeTx({ state: "pending", submitted_at: T0.toISOString() }), minutesAfter(24 * 60 + 1))).next).toBe("needs_review")
  })
})

describe("applyResolve", () => {
  it("admin can resolve a needs_review row as fulfilled or failed", () => {
    const f = next(applyResolve(makeTx({ state: "needs_review" }), "fulfilled", "confirmed with Hubtel", "admin-1", T0))
    expect(f.next).toBe("fulfilled")
    expect(f.patch.resolved_by).toBe("admin-1")
    expect(f.patch.resolution_note).toBe("confirmed with Hubtel")
    const x = next(applyResolve(makeTx({ state: "needs_review" }), "failed", "never delivered", "admin-1", T0))
    expect(x.patch.failure_reason).toBe("never delivered")
  })
  it("resolving the same way twice is a no-op", () => {
    expect("ignored" in applyResolve(makeTx({ state: "fulfilled", resolved_at: T0.toISOString() }), "fulfilled", "x", "a", T0)).toBe(true)
  })
  it("ignores resolve when state already equals outcome even with resolved_at null", () => {
    expect("ignored" in applyResolve(makeTx({ state: "fulfilled" }), "fulfilled", "x", "a", T0)).toBe(true)
    expect("ignored" in applyResolve(makeTx({ state: "failed" }), "failed", "x", "a", T0)).toBe(true)
  })
  it("ignores resolve on in-flight created / pending rows", () => {
    expect("ignored" in applyResolve(makeTx({ state: "created" }), "failed", "x", "a", T0)).toBe(true)
    expect("ignored" in applyResolve(makeTx({ state: "pending" }), "fulfilled", "x", "a", T0)).toBe(true)
  })
  it("allows an explicit override of a terminal row to the opposite outcome", () => {
    const t = next(applyResolve(makeTx({ state: "fulfilled" }), "failed", "reversed", "admin-1", T0))
    expect(t.next).toBe("failed")
    expect(t.patch.resolved_by).toBe("admin-1")
  })
})

describe("hardening", () => {
  it("classifyCode: non-string, malformed and 5xx codes are unknown", () => {
    expect(classifyCode({ a: 1 })).toBe("unknown")
    expect(classifyCode("abc")).toBe("unknown")
    expect(classifyCode("2001", 502)).toBe("unknown")
    expect(classifyCode("2001", 400)).toBe("failed")
    expect(classifyCode("2001")).toBe("failed")
  })
  it("post: object code, 'abc' and 5xx-with-code -> needs_review", () => {
    for (const res of [
      { httpStatus: 200, body: { ResponseCode: { x: 1 } } },
      { httpStatus: 200, body: { ResponseCode: "abc" } },
      { httpStatus: 503, body: { ResponseCode: "2001", Message: "oops" } },
    ]) expect(next(applyPostResponse(makeTx(), res, T0)).next).toBe("needs_review")
  })
  it("callback: trims transactionId and never overwrites existing values with null", () => {
    const tx = makeTx({ state: "pending", hubtel_transaction_id: "old", external_transaction_id: "oe", amount_debited: 7, charges: 1 })
    const t = next(applyCallback(tx, cb({ transactionId: "  new1 " }), T0))
    expect(t.patch.hubtel_transaction_id).toBe("new1")
    const u = next(applyCallback(tx, cb({ transactionId: null as any, externalTransactionId: null as any, amountDebited: null as any, charges: null as any }), T0))
    expect(u.patch.hubtel_transaction_id).toBe("old")
    expect(u.patch.external_transaction_id).toBe("oe")
    expect(u.patch.amount_debited).toBe(7)
    expect(u.patch.charges).toBe(1)
  })
  it("callback 4075 -> failed with float flag", () => {
    const t = next(applyCallback(makeTx({ state: "pending" }), cb({ responseCode: "4075" }), T0))
    expect(t.next).toBe("failed")
    expect(t.float).toBe(true)
  })
  it("exact boundaries", () => {
    const pend = (over = {}) => makeTx({ state: "pending", submitted_at: T0.toISOString(), ...over })
    const neg = { ok: true, status: "Unpaid", isFulfilled: false }
    expect(next(applyStatusCheck(pend({ negative_checks: 1 }), neg, minutesAfter(10))).next).toBe("failed")
    expect(next(applyStatusCheck(pend({ negative_checks: 1 }), neg, new Date(minutesAfter(10).getTime() - 1000))).next).toBe("pending")
    expect(next(sweepStale(pend(), minutesAfter(24 * 60))).next).toBe("needs_review")
    expect(next(sweepStale(makeTx({ state: "created" }), minutesAfter(2))).next).toBe("needs_review")
  })
  it("needs_review row can be failed by two negatives", () => {
    const tx = makeTx({ state: "needs_review", submitted_at: T0.toISOString(), negative_checks: 1 })
    expect(next(applyStatusCheck(tx, { ok: true, status: "Unpaid", isFulfilled: false }, minutesAfter(12))).next).toBe("failed")
  })
})
