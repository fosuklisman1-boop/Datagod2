import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  user: null as any,
  cfg: { enabled: true, surfaces: { api: true }, rates: {}, shares: {}, groups: {} } as any,
  buy: vi.fn(),
  catalog: vi.fn(),
  place: vi.fn(),
  getSandbox: vi.fn(),
  guard: vi.fn(),
  dbCalls: [] as any[],
  orderRow: null as any,
}))

vi.mock("@/lib/api-auth", () => ({
  authenticateApiKey: vi.fn(async () => h.user),
  logApiRequest: vi.fn(async () => {}),
}))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: vi.fn(async () => ({ allowed: true })) }))
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified: (...a: any[]) => h.guard(...a) }))
vi.mock("@/lib/standard-bundles/service", () => ({ buyBundle: (...a: any[]) => h.buy(...a) }))
vi.mock("@/lib/standard-bundles/catalog", () => ({ getCatalog: (...a: any[]) => h.catalog(...a) }))
vi.mock("@/lib/sandbox", () => ({
  placeSandboxOrder: (...a: any[]) => h.place(...a),
  getSandboxOrder: (...a: any[]) => h.getSandbox(...a),
}))
vi.mock("@/lib/standard-bundles/runtime", () => {
  const chain = (result: any) => {
    const q: any = {}
    q.select = () => q
    q.eq = (c: string, v: unknown) => { h.dbCalls.push([c, v]); return q }
    q.maybeSingle = async () => result()
    return q
  }
  return {
    getBundlesRuntime: () => ({
      deps: { getCashbackConfig: async () => h.cfg, getBuyerTier: async () => "dealer" },
      db: { from: () => chain(() => ({ data: h.orderRow, error: null })) },
    }),
  }
})


import { GET, POST } from "./route"
import { GET as GET_ONE } from "./[reference]/route"

const get = (qs = "?network=MTN") => GET(new NextRequest("http://localhost/api/v1/bundles" + qs))
const post = (body: unknown) => POST(new NextRequest("http://localhost/api/v1/bundles", { method: "POST", body: JSON.stringify(body) }))
const BODY = { bundle_token: "tok", phone: "0541234567", idempotency_key: "idem-12345678" }
const ROW = {
  reference_code: "SB-1", status: "pending", payment_status: "paid", amount: 10, paid_amount: 9.81, cashback_amount: 0.19,
  network: "MTN", bundle_display: "1GB", beneficiary_phone: "233541234567", created_at: "2026-10-14T00:00:00Z",
}

beforeEach(() => {
  vi.clearAllMocks()
  h.dbCalls.length = 0
  h.user = { id: "owner-1", role: "dealer", api_key_id: "key-1", environment: "live", rate_limit_per_min: 60 }
  h.cfg = { enabled: true, surfaces: { api: true }, rates: {}, shares: {}, groups: {} }
  h.guard.mockResolvedValue({ allowed: true })
  h.buy.mockResolvedValue({ ok: true, order: { ...ROW } })
  h.orderRow = { ...ROW }
})

describe("auth", () => {
  it("401 without a valid key", async () => {
    h.user = null
    expect((await get()).status).toBe(401)
    expect((await post(BODY)).status).toBe(401)
  })
})

describe("GET /api/v1/bundles", () => {
  it("400 on a bad network", async () => {
    expect((await get("?network=VODA")).status).toBe(400)
  })
  it("403 not_available when the api surface is off", async () => {
    h.cfg.surfaces.api = false
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: "not_available" })
    expect(h.catalog).not.toHaveBeenCalled()
  })
  it("returns snake_case priced categories", async () => {
    h.catalog.mockResolvedValue({ ok: true, categories: [{ name: "Data", bundles: [{ token: "tok", display: "1GB", amount: 10, value: "x", category: "Data" }] }] })
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true, network: "MTN",
      categories: [{ name: "Data", bundles: [{ bundle_token: "tok", display: "1GB", face_amount: 10, pay_amount: 10, customer_cashback: 0 }] }],
    })
  })
  it("a catalog 403 (bundles disabled) is reported as not_available", async () => {
    h.catalog.mockResolvedValue({ ok: false, status: 403, error: "Standard Bundles are not available" })
    const res = await get()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("not_available")
  })
  it("sandbox key gets the static catalog and never touches the live engine", async () => {
    h.user.environment = "test"
    const res = await get()
    const json = await res.json()
    expect(json.sandbox).toBe(true)
    expect(json.categories[0].bundles[0].bundle_token).toMatch(/^sbx_/)
    expect(h.catalog).not.toHaveBeenCalled()
  })
})

describe("POST /api/v1/bundles", () => {
  it("400 on missing fields", async () => {
    expect((await post({ phone: "0541234567" })).status).toBe(400)
  })
  it("403 not_available when the api surface is off; nothing bought", async () => {
    h.cfg.surfaces.api = false
    const res = await post(BODY)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("not_available")
    expect(h.buy).not.toHaveBeenCalled()
  })
  it("403 when the phone is not verified", async () => {
    h.guard.mockResolvedValue({ allowed: false, error: "Verify your phone" })
    expect((await post(BODY)).status).toBe(403)
    expect(h.buy).not.toHaveBeenCalled()
  })
  it("buys on the api channel for the key owner and forwards expected_pay", async () => {
    const res = await post({ ...BODY, expected_pay: "9.81" })
    expect(res.status).toBe(201)
    expect(h.buy.mock.calls[0][1]).toBe("owner-1")
    expect(h.buy.mock.calls[0][2]).toEqual({
      token: "tok", phone: "0541234567", idempotencyKey: "idem-12345678", expectedPay: 9.81, channel: "api",
    })
    expect((await res.json()).order.reference).toBe("SB-1")
  })
  it("price change => 409 price_changed (snake_case)", async () => {
    h.buy.mockResolvedValue({ ok: false, status: 409, error: "Price updated — please review", quote: { faceAmount: 10, payAmount: 9.81, customerCashback: 0.19 } })
    const res = await post({ ...BODY, expected_pay: 10 })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      success: false, error: "price_changed", message: "Price updated — please review",
      quote: { face_amount: 10, pay_amount: 9.81, customer_cashback: 0.19 },
    })
  })
  it("an engine throw is a generic 500 with no leaked message", async () => {
    h.buy.mockRejectedValue(new Error("pg: secret detail"))
    const res = await post(BODY)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret")
  })
  it("sandbox key never reaches buyBundle and is placed as an instant order", async () => {
    h.user.environment = "test"
    h.place.mockResolvedValue({ success: true, order: { reference: "SB-X", status: "completed" }, newBalance: 95 })
    const res = await post({ ...BODY, bundle_token: "sbx_mtn_1gb" })
    expect(res.status).toBe(201)
    expect(h.buy).not.toHaveBeenCalled()
    expect(h.guard).not.toHaveBeenCalled()
    expect(h.place.mock.calls[0][0]).toMatchObject({ userId: "owner-1", price: 5, instant: true })
  })
  it("sandbox replay of the same idempotency key returns the first order", async () => {
    h.user.environment = "test"
    h.place.mockResolvedValue({ success: false, error: "Duplicate reference", status: 409 })
    h.getSandbox.mockResolvedValue({ response: { reference: "SB-X", status: "completed" }, status: "completed" })
    const res = await post({ ...BODY, bundle_token: "sbx_mtn_1gb" })
    expect(res.status).toBe(200)
    expect((await res.json()).order.reference).toBe("SB-X")
  })
  it("sandbox rejects an unknown token", async () => {
    h.user.environment = "test"
    expect((await post(BODY)).status).toBe(409)
    expect(h.place).not.toHaveBeenCalled()
  })
})

describe("GET /api/v1/bundles/{reference}", () => {
  const one = (ref = "SB-1") => GET_ONE(new NextRequest("http://localhost/api/v1/bundles/" + ref), { params: Promise.resolve({ reference: ref }) })

  it("scopes the lookup to the key owner", async () => {
    const res = await one()
    expect(res.status).toBe(200)
    expect(h.dbCalls).toContainEqual(["user_id", "owner-1"])
    expect(h.dbCalls).toContainEqual(["reference_code", "SB-1"])
    expect((await res.json()).order).toMatchObject({ reference: "SB-1", face_amount: 10, paid_amount: 9.81, cashback: 0.19 })
  })
  it("404 when not the owner's order", async () => {
    h.orderRow = null
    expect((await one()).status).toBe(404)
  })
  it("sandbox reads sandbox orders only", async () => {
    h.user.environment = "test"
    h.getSandbox.mockImplementation(async (_u: string, ref: string) => ref === "SB-X" ? { action: "standard_bundle", response: { reference: "SB-X" }, status: "completed" } : { action: "airtime", response: {}, status: "completed" })
    const res = await one("SB-X")
    expect((await res.json()).order).toMatchObject({ reference: "SB-X", sandbox: true })
    expect((await one("AT-1")).status).toBe(404)
  })
})
