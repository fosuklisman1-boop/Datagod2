import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// v1 airtime wiring: the route always prices on the "api" channel for the API key owner and forwards
// expected_pay. The pricing itself (api switch off => legacy byte-for-byte; on => cashback with the owner's
// tier) is covered against the real purchaseAirtime in lib/airtime-service.test.ts.

const h = vi.hoisted(() => ({
  user: null as any,
  purchase: vi.fn(),
  sandbox: vi.fn(),
}))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: () => { throw new Error("unexpected db read") } }) }))
vi.mock("@/lib/api-auth", () => ({
  authenticateApiKey: vi.fn(async () => h.user),
  logApiRequest: vi.fn(async () => {}),
}))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: vi.fn(async () => ({ allowed: true })) }))
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified: vi.fn(async () => ({ allowed: true })) }))
vi.mock("@/lib/airtime-service", () => ({ purchaseAirtime: (...a: any[]) => h.purchase(...a) }))
vi.mock("@/lib/sandbox", () => ({ placeSandboxOrder: (...a: any[]) => h.sandbox(...a), getSandboxOrder: vi.fn() }))

import { POST } from "./route"

const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/v1/airtime", { method: "POST", body: JSON.stringify(body) }))

const BODY = { network: "MTN", recipient: "0541234567", amount: 10 }

beforeEach(() => {
  vi.clearAllMocks()
  h.user = { id: "owner-1", role: "dealer", api_key_id: "key-1", environment: "live", rate_limit_per_min: 60 }
  h.purchase.mockResolvedValue({ order: { reference_code: "AT-1", status: "pending", total_paid: 9.81, airtime_amount: 10 }, newBalance: 90.19 })
})

describe("POST /api/v1/airtime — api channel wiring", () => {
  it("prices on the api channel for the key owner; no expected_pay => no price check", async () => {
    const res = await post(BODY)
    expect(res.status).toBe(201)
    expect(h.purchase).toHaveBeenCalledTimes(1)
    expect(h.purchase.mock.calls[0][0]).toEqual({
      userId: "owner-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10, paySeparately: false,
      channel: "api", expectedPay: undefined,
    })
    expect(await res.json()).toEqual({
      success: true, order: { reference_code: "AT-1", status: "pending", total_paid: 9.81, airtime_amount: 10 }, new_balance: 90.19,
    })
  })

  it("forwards a numeric expected_pay (string form accepted)", async () => {
    await post({ ...BODY, expected_pay: "9.81" })
    expect(h.purchase.mock.calls[0][0]).toMatchObject({ channel: "api", expectedPay: 9.81 })
  })

  it("PRICE_CHANGED from the service => 409 with the quote, nothing else attempted", async () => {
    h.purchase.mockRejectedValue(Object.assign(new Error("Price updated — please review"), {
      code: "PRICE_CHANGED", quote: { faceAmount: 10, payAmount: 9.81, customerCashback: 0.19 },
    }))
    const res = await post({ ...BODY, expected_pay: 10 })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, quote: { faceAmount: 10, payAmount: 9.81, customerCashback: 0.19 } })
  })

  it("sandbox key never reaches purchaseAirtime", async () => {
    h.user.environment = "test"
    h.sandbox.mockResolvedValue({ success: true, order: { reference: "AT-S" }, newBalance: 100 })
    const res = await post(BODY)
    expect(res.status).toBe(201)
    expect(h.purchase).not.toHaveBeenCalled()
  })
})
