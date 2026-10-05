import { describe, it, expect } from "vitest"
import { interpretRefundResponse, isAttentionStatus, treatAsAmbiguous, parseRefundAmount, isCancelledRefund, attentionHint, describeVerification, LEDGER_MISMATCH_TEXT } from "./ui-outcome"

describe("interpretRefundResponse", () => {
  it("completed => success", () => {
    expect(interpretRefundResponse("execute", 200, { refundId: "r", status: "completed" }).kind).toBe("success")
  })
  it("execute awaiting_otp => awaiting_otp, not wrongOtp", () => {
    const o = interpretRefundResponse("execute", 200, { refundId: "r", status: "awaiting_otp", message: "Enter" })
    expect(o).toMatchObject({ kind: "awaiting_otp", wrongOtp: false, refundId: "r" })
  })
  it("otp awaiting_otp => wrongOtp", () => {
    const o = interpretRefundResponse("otp", 200, { refundId: "r", status: "awaiting_otp", message: "Wrong code" })
    expect(o).toMatchObject({ kind: "awaiting_otp", wrongOtp: true, message: "Wrong code" })
  })
  it("cancel with status failed => success (cancelled)", () => {
    expect(interpretRefundResponse("cancel", 200, { refundId: "r", status: "failed" }).kind).toBe("success")
  })
  it("execute/retry/otp/reconcile failed (502) => payout_failed with server message", () => {
    for (const a of ["execute", "retry", "otp", "reconcile"] as const) {
      expect(interpretRefundResponse(a, 502, { refundId: "r", status: "failed", message: "boom" })).toMatchObject({ kind: "payout_failed", message: "boom" })
    }
  })
  it("processing => warning", () => {
    expect(interpretRefundResponse("reconcile", 200, { refundId: "r", status: "processing" }).kind).toBe("warning")
  })
  it("SETTLE_FAILED surfaces detail verbatim", () => {
    const o = interpretRefundResponse("execute", 500, {
      error: "recording failed", code: "SETTLE_FAILED",
      detail: { ref: "TRF_1", refundId: "abc", ledgerStatus: "processing", note: "money has left" },
    })
    expect(o).toEqual({
      kind: "settle_failed", message: "recording failed",
      detail: { ref: "TRF_1", refundId: "abc", ledgerStatus: "processing", note: "money has left", error: null, outcome: null, conflict: null },
    })
  })
  it("SETTLE_FAILED without detail does not throw", () => {
    expect(interpretRefundResponse("execute", 500, { error: "x", code: "SETTLE_FAILED" }).kind).toBe("settle_failed")
  })
  it("ADMIN_REQUIRED / 403 => auth", () => {
    expect(interpretRefundResponse("execute", 403, { error: "no", code: "ADMIN_REQUIRED" })).toEqual({ kind: "auth", message: "Sign in as an admin" })
    expect(interpretRefundResponse("execute", 403, {})).toMatchObject({ kind: "auth" })
  })
  it("409/422 shows server message and code", () => {
    expect(interpretRefundResponse("execute", 422, { error: "short by GHS 2", code: "SHORTFALL", detail: {} })).toEqual({ kind: "error", message: "short by GHS 2", code: "SHORTFALL", status: 422 })
  })
  it("non-object body => generic error", () => {
    expect(interpretRefundResponse("execute", 500, null)).toMatchObject({ kind: "error" })
  })
})

describe("isAttentionStatus", () => {
  it("flags reserved/processing/awaiting_otp only", () => {
    expect(["reserved", "processing", "awaiting_otp"].every(isAttentionStatus)).toBe(true)
    expect(isAttentionStatus("completed")).toBe(false)
    expect(isAttentionStatus("failed")).toBe(false)
  })
})

describe("settle detail + str", () => {
  it("surfaces outcome/conflict and ignores objects/empty strings", () => {
    const o = interpretRefundResponse("execute", 500, { error: "", code: "SETTLE_FAILED", detail: { outcome: "completed", conflict: true, ref: "", note: {} } })
    expect(o).toMatchObject({ kind: "settle_failed", detail: { outcome: "completed", conflict: "true", ref: null, note: null } })
  })
})

describe("treatAsAmbiguous", () => {
  const run = (status: number, body: unknown) => treatAsAmbiguous(interpretRefundResponse("execute", status, body))
  it("502 non-JSON body => ambiguous", () => expect(run(502, null)).toBe("ambiguous"))
  it("thrown fetch => ambiguous", () => expect(treatAsAmbiguous({ kind: "error", message: "Failed to fetch" })).toBe("ambiguous"))
  it("500 without code => ambiguous", () => expect(run(500, { error: "boom" })).toBe("ambiguous"))
  it("500 RESERVE_FAILED => ambiguous", () => expect(run(500, { error: "x", code: "RESERVE_FAILED" })).toBe("ambiguous"))
  it("SETTLE_FAILED => ambiguous", () => expect(run(500, { error: "x", code: "SETTLE_FAILED", detail: {} })).toBe("ambiguous"))
  it("409 => stale", () => {
    expect(run(409, { error: "x", code: "ORDER_NOT_PENDING" })).toBe("stale")
    expect(run(409, { error: "x", code: "DISPATCH_ACTIVE" })).toBe("stale")
  })
  it("422 SHORTFALL => rejected", () => expect(run(422, { error: "x", code: "SHORTFALL" })).toBe("rejected"))
  it("400 BAD_OTP => rejected", () => expect(run(400, { error: "x", code: "BAD_OTP" })).toBe("rejected"))
  it("403 => rejected", () => expect(run(403, { error: "x", code: "ADMIN_REQUIRED" })).toBe("rejected"))
  it("status reserved is a warning outcome, not an error", () => {
    const o = interpretRefundResponse("execute", 200, { refundId: "r", status: "reserved" })
    expect(o.kind).toBe("warning")
    expect(treatAsAmbiguous(o)).toBe("rejected")
  })
})

describe("parseRefundAmount", () => {
  it("accepts up to 2dp, trims", () => {
    expect(parseRefundAmount("12")).toBe(12)
    expect(parseRefundAmount(" 12.5 ")).toBe(12.5)
    expect(parseRefundAmount("0.01")).toBe(0.01)
  })
  it("rejects 3dp, commas, exponent, signs, empty, zero, junk", () => {
    for (const bad of ["12.345", "1,200", "1e2", "-5", "+5", "", " ", "0", "0.00", ".5", "5.", "abc", "12abc"]) {
      expect(parseRefundAmount(bad)).toBeNull()
    }
  })
})

describe("isCancelledRefund", () => {
  it("only failed rows with Cancelled by admin error", () => {
    expect(isCancelledRefund({ status: "failed", error: "Cancelled by admin" })).toBe(true)
    expect(isCancelledRefund({ status: "failed", error: "Payout rejected" })).toBe(false)
    expect(isCancelledRefund({ status: "completed", error: null })).toBe(false)
  })
})

describe("attentionHint / inFlight (I-1)", () => {
  const NOW = Date.parse("2026-10-05T12:00:00Z")
  const row = (status: string, ageMs: number) => ({ status, updated_at: new Date(NOW - ageMs).toISOString() })
  it("reserved/processing under 5 min => in flight, no check-status, no crash hint", () => {
    for (const status of ["reserved", "processing"]) {
      const h = attentionHint(row(status, 60_000), NOW)
      expect(h.inFlight).toBe(true)
      expect(h.text).toBe("In flight — retry in a few minutes")
    }
  })
  it("reserved older than 5 min => stuck-after-a-crash hint, check status allowed", () => {
    const h = attentionHint(row("reserved", 6 * 60_000), NOW)
    expect(h.inFlight).toBe(false)
    expect(h.text).toMatch(/Stuck after a crash/)
  })
  it("old processing => awaiting-confirmation hint; awaiting_otp never in flight", () => {
    expect(attentionHint(row("processing", 6 * 60_000), NOW)).toMatchObject({ inFlight: false, text: expect.stringMatching(/Awaiting gateway/) })
    expect(attentionHint(row("awaiting_otp", 1000), NOW)).toMatchObject({ inFlight: false, text: expect.stringMatching(/OTP/) })
  })
  it("IN_FLIGHT 409 on an action is a stale-type, non-ambiguous error", () => {
    expect(treatAsAmbiguous({ kind: "error", message: "m", code: "IN_FLIGHT", status: 409 })).toBe("stale")
  })
})

describe("describeVerification", () => {
  it("flags ledger completed + gateway failed as destructive with the runbook text", () => {
    expect(describeVerification({ ledgerStatus: "completed", gatewayStatus: "failed", rawStatus: "failed" })).toEqual({ severity: "destructive", text: LEDGER_MISMATCH_TEXT })
    expect(LEDGER_MISMATCH_TEXT).toBe("Ledger says completed but Paystack says failed — the customer was NOT paid. See runbook.")
  })
  it("completed + processed is ok", () => {
    expect(describeVerification({ ledgerStatus: "completed", gatewayStatus: "completed", rawStatus: "processed" })).toEqual({ severity: "ok", text: "Paystack says: processed" })
  })
  it("completed ledger but Paystack still pending is a warning", () => {
    const r = describeVerification({ ledgerStatus: "completed", gatewayStatus: "pending", rawStatus: "needs-attention" })
    expect(r.severity).toBe("warning")
    expect(r.text).toContain("Paystack says: needs-attention")
  })
  it("processing ledger + terminal gateway tells the admin to Check status", () => {
    expect(describeVerification({ ledgerStatus: "processing", gatewayStatus: "completed", rawStatus: "processed" }).text).toContain("Check status")
    expect(describeVerification({ ledgerStatus: "processing", gatewayStatus: "failed", rawStatus: "failed" }).text).toContain("Check status")
  })
  it("unknown / unavailable is a warning, never destructive", () => {
    expect(describeVerification({ ledgerStatus: "completed", gatewayStatus: "unknown", message: "boom" }).severity).toBe("warning")
    expect(describeVerification({ ledgerStatus: "completed", gatewayStatus: null }).severity).toBe("warning")
  })
})
