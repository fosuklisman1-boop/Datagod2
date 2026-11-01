import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  afterTasks: [] as Array<() => unknown>,
  buyBundle: vi.fn(),
  buySpecial: vi.fn(),
  guard: { allowed: true } as { allowed: boolean; error?: string },
}))

vi.mock("next/server", async importOriginal => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => { h.afterTasks.push(fn) },
}))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async () => ({ allowed: true }) }))
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified: async () => h.guard }))
vi.mock("@/lib/bills/route-auth", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/bills/route-auth")>()), // real readJson
  authenticate: async () => ({ userId: "u1" }),
}))
vi.mock("@/lib/standard-bundles/runtime", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/standard-bundles/runtime")>()), // real pickOrder
  getBundlesRuntime: () => ({ deps: { secret: SECRET, now: () => T0 }, db: { kind: "db" } }),
}))
vi.mock("@/lib/standard-bundles/service", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/standard-bundles/service")>()),
  buyBundle: (...a: unknown[]) => h.buyBundle(...a),
}))
vi.mock("@/lib/standard-bundles/special-service", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/standard-bundles/special-service")>()),
  buySpecial: (...a: unknown[]) => h.buySpecial(...a),
}))

const SECRET = "s".repeat(40)
const T0 = 1_800_000_000_000

import { POST, maxDuration } from "./route"

describe("route config", () => {
  it("maxDuration 300: room for the Special dispatch loop's 240s budget", () => {
    expect(maxDuration).toBe(300)
  })
})
import { signBundleToken, signSpecialToken, BUNDLE_TOKEN_TTL_MS } from "@/lib/standard-bundles/token"

const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e"
const unit = signBundleToken({ network: "MTN", value: "RACT_Data_GHC_3_Others", amount: 3, display: "406.89MB", category: "Data", issuedAt: T0 }, SECRET)
const special = signSpecialToken({ unitToken: unit, n: 3, issuedAt: T0 }, SECRET)
const ORDER = {
  id: "o1", reference_code: "SB-1", network: "MTN", bundle_display: "406.89MB", amount: 3, beneficiary_phone: "233244123456",
  status: "processing", payment_status: "paid", created_at: "c", notes: "raw provider text", paid_amount: null, cashback_amount: null,
}
const post = (body: Record<string, unknown>) =>
  POST(new NextRequest("http://localhost/api/standard-bundles/buy", { method: "POST", body: JSON.stringify(body), headers: { Authorization: "Bearer t" } }))

beforeEach(() => {
  h.afterTasks = []
  h.guard = { allowed: true }
  h.buyBundle.mockReset().mockResolvedValue({ ok: true, order: ORDER })
  h.buySpecial.mockReset().mockResolvedValue({ ok: true, order: { ...ORDER, id: "g1", amount: 9 }, special: { groupId: "g1", n: 3 }, replay: false })
})

describe("POST /api/standard-bundles/buy — normal path unchanged", () => {
  it("a normal token goes to buyBundle with the same arguments and response shape as before; buySpecial never runs", async () => {
    const res = await post({ token: unit, phone: "0244123456", idempotencyKey: KEY, expectedPay: "3.00" })
    expect(h.buySpecial).not.toHaveBeenCalled()
    expect(h.buyBundle).toHaveBeenCalledTimes(1)
    expect(h.buyBundle.mock.calls[0].slice(1)).toEqual(["u1", { token: unit, phone: "0244123456", idempotencyKey: KEY, expectedPay: 3 }])
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({
      success: true,
      order: {
        id: "o1", reference_code: "SB-1", network: "MTN", bundle_display: "406.89MB", amount: 3, beneficiary_phone: "233244123456",
        status: "processing", payment_status: "paid", created_at: "c", faceAmount: 3, paidAmount: 3, cashback: 0,
      },
    })
  })
  it("garbage and foreign-secret tokens also take the normal path", async () => {
    await post({ token: "junk", phone: "0244123456", idempotencyKey: KEY })
    await post({ token: signSpecialToken({ unitToken: unit, n: 3, issuedAt: T0 }, "other"), phone: "0244123456", idempotencyKey: KEY })
    expect(h.buyBundle).toHaveBeenCalledTimes(2)
    expect(h.buySpecial).not.toHaveBeenCalled()
  })
  it("normal failures keep their shape", async () => {
    h.buyBundle.mockResolvedValue({ ok: false, status: 409, error: "Price updated — please review", quote: { faceAmount: 3, payAmount: 2.9, customerCashback: 0.1 } })
    const res = await post({ token: unit, phone: "0244123456", idempotencyKey: KEY })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: "Price updated — please review", quote: { faceAmount: 3, payAmount: 2.9, customerCashback: 0.1 } })
  })
})

describe("POST /api/standard-bundles/buy — special branch", () => {
  it("a special token goes to buySpecial (never buyBundle) with after() wired; response = normal shape + special", async () => {
    const res = await post({ token: special, phone: "0244123456", idempotencyKey: KEY, expectedPay: 9 })
    expect(h.buyBundle).not.toHaveBeenCalled()
    expect(h.buySpecial).toHaveBeenCalledTimes(1)
    const [deps, user, input] = h.buySpecial.mock.calls[0]
    expect(user).toBe("u1")
    expect(input).toEqual({ token: special, phone: "0244123456", idempotencyKey: KEY, expectedPay: 9 })
    expect(typeof deps.createSpecialOrders).toBe("function")
    deps.schedule(async () => {})
    expect(h.afterTasks).toHaveLength(1)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, special: { groupId: "g1", n: 3 }, order: { id: "g1", reference_code: "SB-1", amount: 9, faceAmount: 9 } })
    expect(json.order).not.toHaveProperty("notes")
  })
  it("an expired special token still goes to buySpecial (so its replay lookup runs)", async () => {
    const old = signSpecialToken({ unitToken: signBundleToken({ network: "MTN", value: "V", amount: 3, display: "x", category: "Data", issuedAt: T0 - BUNDLE_TOKEN_TTL_MS * 3 }, SECRET), n: 3, issuedAt: T0 - BUNDLE_TOKEN_TTL_MS * 3 }, SECRET)
    await post({ token: old, phone: "0244123456", idempotencyKey: KEY, expectedPay: 9 })
    expect(h.buySpecial).toHaveBeenCalledTimes(1)
    expect(h.buyBundle).not.toHaveBeenCalled()
  })
  it("special failures: status + error (+ quote)", async () => {
    h.buySpecial.mockResolvedValue({ ok: false, status: 402, error: "Insufficient wallet balance" })
    const res = await post({ token: special, phone: "0244123456", idempotencyKey: KEY, expectedPay: 9 })
    expect(res.status).toBe(402)
    expect(await res.json()).toEqual({ success: false, error: "Insufficient wallet balance" })
    h.buySpecial.mockResolvedValue({ ok: false, status: 409, error: "Price changed. Please try again.", quote: { faceAmount: 9, payAmount: 8.88, customerCashback: 0.12 } })
    const r2 = await post({ token: special, phone: "0244123456", idempotencyKey: KEY, expectedPay: 9 })
    expect(r2.status).toBe(409)
    expect(await r2.json()).toEqual({ success: false, error: "Price changed. Please try again.", quote: { faceAmount: 9, payAmount: 8.88, customerCashback: 0.12 } })
  })
  it("phone-verification guard still applies before the special branch", async () => {
    h.guard = { allowed: false, error: "Verify your phone" }
    const res = await post({ token: special, phone: "0244123456", idempotencyKey: KEY, expectedPay: 9 })
    expect(res.status).toBe(403)
    expect(h.buySpecial).not.toHaveBeenCalled()
  })
})
