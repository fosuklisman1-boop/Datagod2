import { describe, it, expect } from "vitest"
import {
  parseVerifyBody, parseAmount, parseExpectedPay, verifyResponse, payErrorBody, orderBody,
  sandboxVerify, parseSandboxToken, ORDER_COLUMNS, sandboxBillReference, sandboxPriceChanged,
} from "./bills"

describe("api-v1 bills mapping", () => {
  it("maps snake_case verify body", () => {
    const p = parseVerifyBody({ biller: "ecg", account: "123456", broadband_account: "BB1", add_meter: true, consent: true, meter_type: "prepaid" })
    expect(p.biller).toBe("ecg")
    expect(p.inputs).toMatchObject({ account: "123456", broadbandAccount: "BB1", addMeter: true, consent: true })
  })
  it("parses amounts", () => {
    expect(parseAmount("12.5")).toBe(12.5)
    expect(parseAmount("abc")).toBeNaN()
    expect(parseExpectedPay(undefined)).toBeUndefined()
    expect(parseExpectedPay("9")).toBe(9)
  })
  it("shapes verify response with unmasked names", () => {
    const r = verifyResponse({ customerName: "Kofi Mensah", amountDue: 10, suggestedAmount: 10, token: "t" })
    expect(r).toEqual({ success: true, customer_name: "Kofi Mensah", amount_due: 10, suggested_amount: 10, verify_token: "t" })
    const m = verifyResponse({ customerName: null, amountDue: null, suggestedAmount: 0, meters: [{ meter: "1", name: "A", outstanding: 2, token: "x" }] })
    expect(m.meters).toEqual([{ meter: "1", name: "A", outstanding: 2, verify_token: "x" }])
  })
  it("price_changed body", () => {
    const b = payErrorBody({ status: 409, error: "Price updated", quote: { faceAmount: 10, payAmount: 9.5, customerCashback: 0.5 } })
    expect(b).toEqual({ success: false, error: "price_changed", message: "Price updated", quote: { face_amount: 10, pay_amount: 9.5, customer_cashback: 0.5 } })
  })
  it("other pay errors carry reference", () => {
    expect(payErrorBody({ status: 402, error: "Insufficient wallet balance", order: { reference_code: "R1" } as any }))
      .toEqual({ success: false, error: "Insufficient wallet balance", reference: "R1" })
  })
  it("order body defaults and exposes no internals", () => {
    const o = orderBody({ reference_code: "R", biller: "dstv", account_number: "A", customer_name: null, amount: 20, status: "pending", payment_status: "paid" } as any)
    expect(o).toMatchObject({ reference: "R", face_amount: 20, paid_amount: 20, cashback: 0 })
    expect(ORDER_COLUMNS).not.toMatch(/notes|token|hubtel|failure/)
  })
})

describe("sandbox", () => {
  it("verify -> token round trips and is user-bound", () => {
    const r = sandboxVerify("u1", "dstv", { account: "1234567", addMeter: false, consent: false })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const token = (r.body as any).verify_token
    expect(parseSandboxToken("u1", token)).toEqual({ biller: "dstv", account: "1234567" })
    expect(parseSandboxToken("u2", token)).toBeNull()
    expect(parseSandboxToken("u1", "garbage")).toBeNull()
  })
  it("rejects unknown biller and missing account", () => {
    expect(sandboxVerify("u", "nope", { account: "1", addMeter: false, consent: false })).toMatchObject({ ok: false, status: 400 })
    expect(sandboxVerify("u", "dstv", { addMeter: false, consent: false })).toMatchObject({ ok: false, status: 400 })
  })
  it("every verify issues a fresh token (a token pays one order)", () => {
    const a = sandboxVerify("u1", "dstv", { account: "1234567", addMeter: false, consent: false })
    const b = sandboxVerify("u1", "dstv", { account: "1234567", addMeter: false, consent: false })
    const ta = (a as any).body.verify_token, tb = (b as any).body.verify_token
    expect(ta).not.toBe(tb)
    expect(parseSandboxToken("u1", tb)).toEqual({ biller: "dstv", account: "1234567" })
  })
  it("reference is deterministic per verify_token and differs between tokens", () => {
    expect(sandboxBillReference("t1")).toBe(sandboxBillReference("t1"))
    expect(sandboxBillReference("t1")).not.toBe(sandboxBillReference("t2"))
    expect(sandboxBillReference("t1")).toMatch(/^SBX-BILL-[0-9A-F]{12}$/)
  })
  it("expected_pay: match/absent => null; mismatch => the live 409 price_changed body at face", () => {
    expect(sandboxPriceChanged(50, undefined)).toBeNull()
    expect(sandboxPriceChanged(50, 50)).toBeNull()
    expect(sandboxPriceChanged(50, 49)).toEqual({
      success: false, error: "price_changed", message: "Price updated — please review",
      quote: { face_amount: 50, pay_amount: 50, customer_cashback: 0 },
    })
  })
  it("ecg without add_meter lists meters", () => {
    const r = sandboxVerify("u", "ecg", { account: "55555", addMeter: false, consent: false })
    expect(r.ok && (r.body as any).meters).toHaveLength(1)
  })
})
