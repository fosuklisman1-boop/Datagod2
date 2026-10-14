import { describe, it, expect } from "vitest"
import {
  buyResultResponse, findSandboxBundle, mapOrder, parseExpectedPay, parseNetwork, parsePostBody, priceCatalog,
  sandboxCatalog, sandboxReference,
} from "./bundles"

const ROW: any = {
  reference_code: "SB-ABC", status: "pending", payment_status: "paid", amount: 10, paid_amount: 9.81, cashback_amount: 0.19,
  network: "MTN", bundle_display: "1GB", beneficiary_phone: "233541234567", created_at: "2026-10-14T00:00:00Z",
  notes: "raw provider text", user_id: "u1", idempotency_key: "k",
}

describe("mapOrder", () => {
  it("maps to the snake_case allow-list and never leaks other columns", () => {
    expect(mapOrder(ROW)).toEqual({
      reference: "SB-ABC", status: "pending", payment_status: "paid", face_amount: 10, paid_amount: 9.81, cashback: 0.19,
      network: "MTN", bundle: "1GB", phone: "233541234567", created_at: "2026-10-14T00:00:00Z",
    })
  })
  it("paid_amount falls back to face and cashback to 0", () => {
    const o = mapOrder({ ...ROW, paid_amount: null, cashback_amount: null })
    expect(o.paid_amount).toBe(10)
    expect(o.cashback).toBe(0)
  })
})

describe("buyResultResponse", () => {
  it("success => 201 with the mapped order", () => {
    const r = buyResultResponse({ ok: true, order: ROW })
    expect(r.status).toBe(201)
    expect((r.body as any).order.reference).toBe("SB-ABC")
  })
  it("price mismatch => 409 price_changed with a snake_case quote", () => {
    const r = buyResultResponse({ ok: false, status: 409, error: "Price updated — please review", quote: { faceAmount: 10, payAmount: 9.81, customerCashback: 0.19 } })
    expect(r.status).toBe(409)
    expect(r.body).toEqual({
      success: false, error: "price_changed", message: "Price updated — please review",
      quote: { face_amount: 10, pay_amount: 9.81, customer_cashback: 0.19 },
    })
  })
  it("other failures keep status and message; an attached order is mapped", () => {
    const r = buyResultResponse({ ok: false, status: 402, error: "Insufficient wallet balance", order: ROW })
    expect(r.status).toBe(402)
    expect(r.body).toMatchObject({ success: false, error: "Insufficient wallet balance", order: { reference: "SB-ABC" } })
    expect(buyResultResponse({ ok: false, status: 409, error: "Prices refreshed — pick the bundle again" }).body)
      .toEqual({ success: false, error: "Prices refreshed — pick the bundle again" })
  })
})

describe("parsing", () => {
  it("network", () => {
    expect(parseNetwork("mtn")).toBe("MTN")
    expect(parseNetwork("AT")).toBe("AT")
    expect(parseNetwork("VODA")).toBeNull()
    expect(parseNetwork(null)).toBeNull()
  })
  it("expected_pay", () => {
    expect(parseExpectedPay(9.81)).toBe(9.81)
    expect(parseExpectedPay("9.81")).toBe(9.81)
    expect(parseExpectedPay("abc")).toBeUndefined()
    expect(parseExpectedPay(undefined)).toBeUndefined()
  })
  it("post body requires token, phone, idempotency_key", () => {
    expect(parsePostBody({ phone: "0541234567", idempotency_key: "abcdefgh" }).ok).toBe(false)
    const ok = parsePostBody({ bundle_token: "t", phone: "054 123 4567", idempotency_key: "abcdefgh", expected_pay: "5" })
    expect(ok).toEqual({ ok: true, bundleToken: "t", phone: "0541234567", idempotencyKey: "abcdefgh", expectedPay: 5 })
  })
})

describe("priceCatalog", () => {
  const cfg: any = {
    enabled: true, surfaces: { api: true, dashboard: true }, rates: { "data_mtn:hubtel": 2 },
    shares: { default: { customer: 50, dealer: 100, storefrontCustomer: 0, storefrontShop: 0 } }, groups: {},
  }
  const cats = [{ name: "Data", bundles: [{ token: "tok", display: "1GB", amount: 10 }] }]
  it("falls back to face price when cashback is not configured", () => {
    const out = priceCatalog("MTN", cats, { ...cfg, enabled: false }, "dealer")
    expect(out).toEqual([{ name: "Data", bundles: [{ bundle_token: "tok", display: "1GB", face_amount: 10, pay_amount: 10, customer_cashback: 0 }] }])
  })
  it("no config (could not be read) => face price", () => {
    expect(priceCatalog("MTN", cats, null, "dealer")[0].bundles[0]).toMatchObject({ face_amount: 10, pay_amount: 10, customer_cashback: 0 })
  })
  it("never prices above face", () => {
    const b = priceCatalog("MTN", cats, cfg, "dealer")[0].bundles[0]
    expect(b.pay_amount).toBeLessThanOrEqual(b.face_amount)
    expect(b.face_amount - b.pay_amount).toBeCloseTo(b.customer_cashback, 2)
  })
})

describe("sandbox fixtures", () => {
  it("catalog is in the live shape for every network, priced at face", () => {
    for (const n of ["MTN", "TELECEL", "AT"] as const) {
      const cats = sandboxCatalog(n)
      expect(cats.length).toBeGreaterThan(0)
      for (const b of cats[0].bundles) {
        expect(b).toMatchObject({ bundle_token: expect.any(String), display: expect.any(String), customer_cashback: 0 })
        expect(b.pay_amount).toBe(b.face_amount)
        expect(findSandboxBundle(b.bundle_token)).toMatchObject({ network: n, amount: b.face_amount })
      }
    }
    expect(findSandboxBundle("nope")).toBeNull()
  })
  it("reference is deterministic per idempotency key", () => {
    expect(sandboxReference("abc-12345678")).toBe(sandboxReference("abc-12345678"))
    expect(sandboxReference("abc-12345678")).toMatch(/^SB-[0-9A-F]{16}$/)
  })
  it("reference hashes the FULL key: keys that only differ late or by punctuation never collide", () => {
    expect(sandboxReference("reseller-order-2026-0000001")).not.toBe(sandboxReference("reseller-order-2026-0000002"))
    expect(sandboxReference("abc-12345678")).not.toBe(sandboxReference("abc12345678"))
    expect(sandboxReference("a".repeat(64))).not.toBe(sandboxReference("a".repeat(63) + "b"))
  })
})
