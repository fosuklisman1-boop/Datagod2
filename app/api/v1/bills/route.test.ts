import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { resolveBillsConfig } from "@/lib/bills/config"
import { BILLER_KEYS } from "@/lib/bills/billers"
import { resolveCashbackConfig } from "@/lib/cashback/config"
import type { BillOrderRow, BillsDeps } from "@/lib/bills/service"

const h = vi.hoisted(() => ({
  user: null as any,
  cfg: null as any,
  cfgError: null as any,
  deps: null as any,
  guard: vi.fn(),
  /** null => the real engine function runs against h.deps. */
  pay: null as null | ((...a: any[]) => any),
  verify: null as null | ((...a: any[]) => any),
  place: vi.fn(),
  getSandbox: vi.fn(),
  rate: vi.fn(),
  log: vi.fn(async (..._a: any[]) => {}),
  orderRow: null as any,
  orderError: null as any,
  dbCalls: [] as any[],
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => {
    const q: any = {}
    q.from = () => q
    q.select = () => q
    q.eq = (c: string, v: unknown) => { h.dbCalls.push([c, v]); return q }
    q.maybeSingle = async () => ({ data: h.orderError ? null : h.orderRow, error: h.orderError })
    return q
  },
}))
vi.mock("@/lib/api-auth", () => ({
  authenticateApiKey: vi.fn(async () => h.user),
  logApiRequest: (...a: any[]) => h.log(...a),
}))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: (...a: any[]) => h.rate(...a) }))
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified: (...a: any[]) => h.guard(...a) }))
vi.mock("@/lib/bills/runtime", () => ({ getBillsRuntime: () => ({ deps: h.deps, db: {} }) }))
vi.mock("@/lib/bills/service", async (importOriginal) => {
  const a = await importOriginal<typeof import("@/lib/bills/service")>()
  return {
    ...a,
    payBill: (...x: any[]) => (h.pay ?? (a.payBill as any))(...x),
    verifyBill: (...x: any[]) => (h.verify ?? (a.verifyBill as any))(...x),
  }
})
vi.mock("@/lib/sandbox", () => ({
  placeSandboxOrder: (...a: any[]) => h.place(...a),
  getSandboxOrder: (...a: any[]) => h.getSandbox(...a),
}))

import { POST as PAY } from "./route"
import { POST as VERIFY } from "./verify/route"
import { GET as GET_ONE } from "./[reference]/route"

const req = (path: string, body: unknown) => new NextRequest("http://localhost" + path, { method: "POST", body: JSON.stringify(body) })
const verify = (body: unknown) => VERIFY(req("/api/v1/bills/verify", body))
const pay = (body: unknown) => PAY(req("/api/v1/bills", body))
const one = (ref = "BILL-1") => GET_ONE(new NextRequest("http://localhost/api/v1/bills/" + ref), { params: Promise.resolve({ reference: ref }) })
const loggedStatuses = () => h.log.mock.calls.map((c: any[]) => c[0].statusCode)

/** In-memory engine deps (the real verifyBill/payBill run against these). */
function fakeDeps() {
  const orders: BillOrderRow[] = []
  const calls = { debit: 0, purchase: 0, insert: 0 }
  const hashes = new Set<string>()
  const d: BillsDeps = {
    getCashbackConfig: async () => { if (h.cfgError) throw h.cfgError; return h.cfg },
    getBuyerTier: async () => "dealer",
    getBillsConfig: async () => resolveBillsConfig({ enabled: true, billers: Object.fromEntries(BILLER_KEYS.map(k => [k, { enabled: true, min: 5, max: 1000 }])) }),
    getHubtelConfig: async () => ({ enabled: true, paused: false, services: Object.fromEntries(BILLER_KEYS.map(k => ["bill_" + k, true])) }),
    query: async () => ({ ok: true, data: [{ Display: "Name", Value: "Kofi", Amount: 0 }, { Display: "Amount Due", Value: "42.5", Amount: 0 }] }) as any,
    purchase: async () => { calls.purchase++; return { client_reference: "CR1", state: "pending" } as any },
    insertOrder: async (r) => {
      calls.insert++
      if (hashes.has(r.verify_token_hash)) throw Object.assign(new Error("duplicate key"), { code: "23505" })
      hashes.add(r.verify_token_hash)
      const o = { ...r, id: "o" + (orders.length + 1), hubtel_client_reference: null, commission: null, failure_reason: null, notes: null, created_at: "", updated_at: "" } as BillOrderRow
      orders.push(o)
      return { ...o }
    },
    getOrder: async (id) => { const o = orders.find(x => x.id === id); return o ? { ...o } : null },
    findApiOrderByTokenHash: async (userId, hash) => {
      const o = orders.find(x => x.user_id === userId && (x as any).verify_token_hash === hash && x.channel === "api")
      return o ? { ...o } : null
    },
    updateOrder: async (id, patch) => { Object.assign(orders.find(x => x.id === id)!, patch); return 1 },
    debitOrder: async (id) => { calls.debit++; orders.find(x => x.id === id)!.payment_status = "paid"; return "ok" },
    alert: async () => {},
    newReference: () => "BILL-" + (orders.length + 1).toString().padStart(12, "0"),
    secret: "s".repeat(40),
    now: () => 1_000_000,
  }
  return { d, orders, calls }
}

const ORDER: any = {
  reference_code: "BILL-1", biller: "dstv", account_number: "1234567890", customer_name: "Kofi", amount: 50,
  paid_amount: 49, cashback_amount: 1, status: "pending", payment_status: "paid", created_at: "2026-10-14T00:00:00Z",
}

beforeEach(() => {
  vi.clearAllMocks()
  h.dbCalls.length = 0
  h.user = { id: "owner-1", role: "dealer", api_key_id: "key-1", environment: "live", rate_limit_per_min: 60 }
  h.cfg = resolveCashbackConfig({ enabled: true, surfaces: { api: true } })
  h.cfgError = null
  h.deps = fakeDeps().d
  h.pay = vi.fn(async () => ({ ok: true, order: { ...ORDER } }))
  h.verify = vi.fn(async () => ({ ok: true, customerName: "Kofi", amountDue: 50, suggestedAmount: 50, token: "vt" }))
  h.guard.mockResolvedValue({ allowed: true })
  h.rate.mockResolvedValue({ allowed: true })
  h.orderRow = { ...ORDER }
  h.orderError = null
})

describe("API surface switch (live keys)", () => {
  it("surface off => verify 403 not_available, nothing verified, logged", async () => {
    h.cfg = resolveCashbackConfig({ enabled: true, surfaces: { api: false, dashboard: true } })
    const res = await verify({ biller: "dstv", account: "1234567890" })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: "not_available" })
    expect(h.verify).not.toHaveBeenCalled()
    expect(h.guard).not.toHaveBeenCalled()
    expect(loggedStatuses()).toEqual([403])
  })
  it("surface off => pay 403 not_available, nothing paid, logged", async () => {
    h.cfg = resolveCashbackConfig({ enabled: false, surfaces: { api: true } })
    const res = await pay({ verify_token: "vt", amount: 50 })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: "not_available" })
    expect(h.pay).not.toHaveBeenCalled()
    expect(loggedStatuses()).toEqual([403])
  })
  it("sandbox keys are not gated by the switch", async () => {
    h.cfg = resolveCashbackConfig({ enabled: false })
    h.user.environment = "test"
    expect((await verify({ biller: "dstv", account: "1234567890" })).status).toBe(200)
    expect(h.verify).not.toHaveBeenCalled()
  })
  it("cashback config unreadable => fails closed: 403 not_available on verify and pay", async () => {
    h.cfgError = new Error("db down")
    expect((await verify({ biller: "dstv", account: "1234567890" })).status).toBe(403)
    expect((await pay({ verify_token: "vt", amount: 50 })).status).toBe(403)
  })
  it("phone not verified => 403, logged", async () => {
    h.guard.mockResolvedValue({ allowed: false, error: "Verify your phone" })
    expect((await verify({ biller: "dstv", account: "1" })).status).toBe(403)
    expect((await pay({ verify_token: "vt", amount: 50 })).status).toBe(403)
    expect(loggedStatuses()).toEqual([403, 403])
  })
})

describe("POST /api/v1/bills/verify", () => {
  it("uses the POST limit max(5, floor(limit/3))", async () => {
    await verify({ biller: "dstv", account: "1" })
    expect(h.rate.mock.calls[0][2]).toBe(20)
    h.user.rate_limit_per_min = 6
    await verify({ biller: "dstv", account: "1" })
    expect(h.rate.mock.calls[1][2]).toBe(5)
  })
  it("an engine throw is a generic 500 with no leaked message", async () => {
    h.verify = vi.fn(async () => { throw new Error("pg: secret detail") })
    const res = await verify({ biller: "dstv", account: "1" })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret")
  })
})

describe("POST /api/v1/bills — retry with a used verify_token (real engine)", () => {
  it("timeout-retry: the retry gets 201 with the SAME reference; one order, one debit, one Hubtel send", async () => {
    const f = fakeDeps(); h.deps = f.d; h.pay = null; h.verify = null
    const v = await (await verify({ biller: "dstv", account: "1234567890" })).json()
    expect(v.verify_token).toEqual(expect.any(String))

    const first = await pay({ verify_token: v.verify_token, amount: 50 })
    expect(first.status).toBe(201)
    const firstRef = (await first.json()).order.reference

    const retry = await pay({ verify_token: v.verify_token, amount: 50 })
    expect(retry.status).toBe(201)
    const body = await retry.json()
    expect(body).toMatchObject({ success: true, order: { reference: firstRef, biller: "dstv", account: "1234567890" } })
    expect(f.calls.insert).toBe(1)
    expect(f.calls.debit).toBe(1)
    expect(f.calls.purchase).toBe(1)
  })
})

describe("POST /api/v1/bills — sandbox", () => {
  const sandboxToken = async () => {
    h.user.environment = "test"
    return (await (await verify({ biller: "dstv", account: "1234567890" })).json()).verify_token as string
  }

  it("re-sending a sandbox token returns the first order (201), no second placement", async () => {
    const t = await sandboxToken()
    h.getSandbox.mockResolvedValueOnce(null)
    h.place.mockResolvedValue({ success: true, order: { reference: "SBX-BILL-1", status: "pending" }, newBalance: 50 })
    expect((await pay({ verify_token: t, amount: 50 })).status).toBe(201)
    const ref = h.place.mock.calls[0][0].reference
    h.getSandbox.mockResolvedValue({ action: "utility_bill", response: { reference: ref, status: "pending" }, status: "pending" })
    const retry = await pay({ verify_token: t, amount: 50 })
    expect(retry.status).toBe(201)
    expect((await retry.json()).order).toMatchObject({ reference: ref, sandbox: true })
    expect(h.place).toHaveBeenCalledTimes(1)
    expect(h.getSandbox.mock.calls[1][1]).toBe(ref) // deterministic per token
  })
  it("a concurrent duplicate (placement 409) also returns the existing order", async () => {
    const t = await sandboxToken()
    h.getSandbox.mockResolvedValueOnce(null).mockResolvedValueOnce({ action: "utility_bill", response: { reference: "R" }, status: "pending" })
    h.place.mockResolvedValue({ success: false, error: "Duplicate reference", status: 409 })
    const res = await pay({ verify_token: t, amount: 50 })
    expect(res.status).toBe(201)
    expect((await res.json()).order.reference).toBe("R")
  })
  it("honours expected_pay: a mismatch is the live 409 price_changed shape, nothing placed", async () => {
    const t = await sandboxToken()
    h.getSandbox.mockResolvedValue(null)
    const res = await pay({ verify_token: t, amount: 50, expected_pay: 49 })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      success: false, error: "price_changed", message: "Price updated — please review",
      quote: { face_amount: 50, pay_amount: 50, customer_cashback: 0 },
    })
    expect(h.place).not.toHaveBeenCalled()
  })
  it("never reaches the live engine and is logged", async () => {
    const t = await sandboxToken()
    h.getSandbox.mockResolvedValue(null)
    h.place.mockResolvedValue({ success: true, order: { reference: "x", status: "pending" }, newBalance: 50 })
    await pay({ verify_token: t, amount: 50 })
    expect(h.pay).not.toHaveBeenCalled()
    expect(h.guard).not.toHaveBeenCalled()
    expect(loggedStatuses()).toEqual([200, 201])
  })
})

describe("GET /api/v1/bills/{reference}", () => {
  it("scopes the lookup to the key owner", async () => {
    const res = await one()
    expect(res.status).toBe(200)
    expect(h.dbCalls).toContainEqual(["user_id", "owner-1"])
    expect((await res.json()).order).toMatchObject({ reference: "BILL-1", face_amount: 50, paid_amount: 49 })
  })
  it("404 when not found", async () => {
    h.orderRow = null
    expect((await one()).status).toBe(404)
  })
  it("a database error is a 500, not a 404, with no leaked message", async () => {
    h.orderError = { message: "pg down", code: "08006" }
    const res = await one()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("pg down")
    expect(loggedStatuses()).toEqual([500])
  })
  it("sandbox lookups are logged", async () => {
    h.user.environment = "test"
    h.getSandbox.mockResolvedValue(null)
    expect((await one("SBX-BILL-X")).status).toBe(404)
    expect(loggedStatuses()).toEqual([404])
  })
})
