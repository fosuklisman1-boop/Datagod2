import { describe, it, expect } from "vitest"
import { interpretRefundResponse, isAttentionStatus } from "./ui-outcome"

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
      detail: { ref: "TRF_1", refundId: "abc", ledgerStatus: "processing", note: "money has left", error: null },
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
    expect(interpretRefundResponse("execute", 422, { error: "short by GHS 2", code: "SHORTFALL", detail: {} })).toEqual({ kind: "error", message: "short by GHS 2", code: "SHORTFALL" })
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
