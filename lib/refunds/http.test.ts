import { describe, expect, it } from "vitest"
import { vi } from "vitest"
import { REFUND_STATUS, parseAmount, parseGateway, parsePage, isUuid, refundErrorResponse, settledHttpStatus, requireAdminUser, auditRefundError, badRequest } from "./http"
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

describe("settledHttpStatus", () => {
  it("failed => 502 for execute/retry/otp/reconcile, 200 for cancel; everything else 200", () => {
    for (const r of ["execute", "retry", "otp", "reconcile"] as const) expect(settledHttpStatus(r, "failed")).toBe(502)
    expect(settledHttpStatus("cancel", "failed")).toBe(200)
    for (const r of ["execute", "retry", "otp", "cancel", "reconcile"] as const)
      for (const st of ["completed", "processing", "awaiting_otp"] as const) expect(settledHttpStatus(r, st)).toBe(200)
  })
})

describe("requireAdminUser", () => {
  it("403 ADMIN_REQUIRED without a userId, null with one", async () => {
    const res = requireAdminUser(undefined)!
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe("ADMIN_REQUIRED")
    expect(requireAdminUser("u1")).toBeNull()
  })
})

it("badRequest carries code BAD_REQUEST", async () => {
  const res = badRequest("x")
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "x", code: "BAD_REQUEST" })
})

describe("auditRefundError", () => {
  const fakeDb = () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    return { insert, db: { from: vi.fn(() => ({ insert })) } as any }
  }
  it("writes <action>_error for SETTLE_FAILED with the detail", async () => {
    const { db, insert } = fakeDb()
    const detail = { outcome: "completed", ref: "TRF_1", refundId: "r1" }
    await auditRefundError(db, "admin1", "order_refund", new RefundError("SETTLE_FAILED", "boom", detail), { table: "shop_orders" })
    expect(db.from).toHaveBeenCalledWith("admin_audit_log")
    const row = insert.mock.calls[0][0]
    expect(row.action).toBe("order_refund_error")
    expect(row.admin_id).toBe("admin1")
    expect(row.new_value).toEqual({ table: "shop_orders", code: "SETTLE_FAILED", error: "boom", detail })
  })
  it("also audits other RefundErrors whose detail names a refundId, but not plain ones or unknown errors", async () => {
    const { db, insert } = fakeDb()
    await auditRefundError(db, "a", "x", new RefundError("RESERVE_FAILED", "m", { refundId: "r" }))
    expect(insert).toHaveBeenCalledTimes(1)
    await auditRefundError(db, "a", "x", new RefundError("NOT_FOUND", "m"))
    await auditRefundError(db, "a", "x", new Error("other"))
    expect(insert).toHaveBeenCalledTimes(1)
  })
  it("never throws when the insert fails or throws", async () => {
    const db = { from: () => ({ insert: () => Promise.reject(new Error("db down")) }) } as any
    await expect(auditRefundError(db, "a", "x", new RefundError("SETTLE_FAILED", "m"))).resolves.toBeUndefined()
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
    expect(parsePage("100", 100)).toBe(100)
    expect(parsePage("101", 100)).toBeNull()
  })
})
