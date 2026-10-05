import { describe, expect, it } from "vitest"
import { REFUND_STATUS, parseAmount, parseGateway, parsePage, isUuid, refundErrorResponse, settledStatus } from "./http"
import { REFUND_ERROR_CODES, RefundError } from "./service"

describe("refundErrorResponse", () => {
  it.each([
    ["NOT_FOUND", 404], ["NOT_ELIGIBLE", 409], ["ALREADY_REFUNDED", 409], ["ORDER_NOT_PENDING", 409],
    ["DISPATCH_ACTIVE", 409], ["SHORTFALL", 422], ["BAD_AMOUNT", 400], ["BAD_OTP", 400],
    ["GATEWAY_UNSUPPORTED", 400], ["RESERVE_FAILED", 500], ["SETTLE_FAILED", 500],
  ] as const)("%s -> %i", async (code, status) => {
    const res = refundErrorResponse(new RefundError(code, "msg", { x: 1 }))
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: "msg", code, detail: { x: 1 } })
  })
  it("has a status for every RefundErrorCode", () => {
    for (const code of REFUND_ERROR_CODES) expect(REFUND_STATUS[code], code).toBeTypeOf("number")
    expect(Object.keys(REFUND_STATUS).sort()).toEqual([...REFUND_ERROR_CODES].sort())
  })
  it("passes SETTLE_FAILED detail through unchanged", async () => {
    const detail = { outcome: "completed", ref: "TRF_1", conflict: true, ledgerStatus: "failed", note: "n" }
    const res = refundErrorResponse(new RefundError("SETTLE_FAILED", "m", detail))
    expect((await res.json()).detail).toEqual(detail)
  })
  it("hides unexpected errors behind a 500", async () => {
    const res = refundErrorResponse(new Error("secret db detail"))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret db detail")
  })
})

describe("settledStatus", () => {
  it("maps failed to 502 and the rest to 200", () => {
    expect(settledStatus("failed")).toBe(502)
    for (const s of ["completed", "processing", "awaiting_otp"] as const) expect(settledStatus(s)).toBe(200)
  })
})

describe("input parsing", () => {
  it("isUuid", () => {
    expect(isUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true)
    for (const v of ["", "abc", "123e4567-e89b-12d3-a456-42661417400", 5, null, undefined, "../x"]) expect(isUuid(v)).toBe(false)
  })
  it("parseAmount accepts finite numbers only", () => {
    expect(parseAmount(12.5)).toBe(12.5)
    expect(parseAmount("12.5")).toBe(12.5)
    for (const v of [NaN, Infinity, "abc", "12abc", "", " ", null, undefined, true, {}, []]) expect(parseAmount(v)).toBeNull()
  })
  it("parseGateway", () => {
    expect(parseGateway("paystack")).toBe("paystack")
    for (const v of ["", "  ", "x".repeat(41), 3, null]) expect(parseGateway(v)).toBeNull()
  })
  it("parsePage", () => {
    expect(parsePage(null)).toBe(1)
    expect(parsePage("3")).toBe(3)
    expect(parsePage("1000")).toBe(1000)
    for (const v of ["0", "-1", "1.5", "abc", "1001", "1e3"]) expect(parsePage(v)).toBeNull()
  })
})
