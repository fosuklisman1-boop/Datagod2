import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeFake, reqOf, ctx, ADMIN, ID, role } from "../../test-utils"
import { HUB_SERVICE_KEYS } from "@/lib/roles/admin/validate"

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  fake: null as unknown as ReturnType<typeof makeFake>,
  fee: vi.fn(),
  cfg: vi.fn(),
}))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: h.verify }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake.db }))
vi.mock("@/lib/airtime-pricing", () => ({ airtimeFeeRateFor: h.fee }))
vi.mock("@/lib/cashback/config", async (orig) => ({ ...(await orig<typeof import("@/lib/cashback/config")>()), getCashbackConfig: h.cfg }))
import { NextResponse } from "next/server"
import { resolveCashbackConfig } from "@/lib/cashback/config"
import { GET, PUT } from "./route"

const DEALER = "55555555-5555-4555-8555-555555555555"
const USER = "66666666-6666-4666-8666-666666666666"

beforeEach(() => {
  h.fake = makeFake()
  h.verify.mockReset()
  h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
  h.fee.mockReset()
  h.fee.mockImplementation(async (net: string, slug: string) => (slug === "dealer" ? 3.5 : 6))
  h.cfg.mockReset()
  h.cfg.mockResolvedValue(
    resolveCashbackConfig({ shares: { airtime: { customer: 20, dealer: 40, storefrontCustomer: 0, storefrontShop: 0 } } }),
  )
  h.fake.tables.roles = {
    data: [
      role(ID, "gold", 30),
      role(USER, "user", 0, { is_system: true }),
      role(DEALER, "dealer", 10, { is_system: true }),
    ],
  }
  h.fake.tables.role_service_rates = { data: [{ role_id: ID, service_key: "airtime_fee:mtn", value: 2 }] }
})

const put = (body: unknown, id = ID) => PUT(reqOf("PUT", body), ctx(id))

describe("GET /api/admin/roles/[id]/rates", () => {
  it("401 non-admin; 404 unknown role; 400 bad id", async () => {
    h.verify.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await GET(reqOf("GET"), ctx())).status).toBe(401)
    h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
    expect((await GET(reqOf("GET"), ctx("77777777-7777-4777-8777-777777777777"))).status).toBe(404)
    expect((await GET(reqOf("GET"), ctx("nope"))).status).toBe(400)
  })
  it("lists exactly the hub service keys with own value and effective", async () => {
    const body = await (await GET(reqOf("GET"), ctx())).json()
    expect(body.editable).toBe(true)
    expect(body.rates.map((r: { service_key: string }) => r.service_key)).toEqual(HUB_SERVICE_KEYS.map((k) => k.key))
    const mtn = body.rates.find((r: { service_key: string }) => r.service_key === "airtime_fee:mtn")
    expect(mtn).toMatchObject({ label: "MTN airtime fee", value: 2 })
    const telecel = body.rates.find((r: { service_key: string }) => r.service_key === "airtime_fee:telecel")
    expect(telecel.value).toBeNull()
    expect(h.fee).toHaveBeenCalledWith("telecel", "gold")
    expect(h.fee).toHaveBeenCalledWith("at", "gold")
  })
  it("dealer: not editable, effective is today's settings value", async () => {
    h.fake.tables.role_service_rates = { data: [] }
    const body = await (await GET(reqOf("GET"), ctx(DEALER))).json()
    expect(body.editable).toBe(false)
    const mtn = body.rates.find((r: { service_key: string }) => r.service_key === "airtime_fee:mtn")
    expect(mtn).toMatchObject({ value: null, effective: 3.5 })
    const air = body.rates.find((r: { service_key: string }) => r.service_key === "cashback_share:airtime")
    expect(air).toMatchObject({ value: null, effective: 40 })
    const user = await (await GET(reqOf("GET"), ctx(USER))).json()
    expect(user.rates.find((r: { service_key: string }) => r.service_key === "cashback_share:airtime").effective).toBe(20)
  })
  it("500 with nothing partial on any read failure", async () => {
    h.fee.mockRejectedValue(new Error("db"))
    let res = await GET(reqOf("GET"), ctx())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Something went wrong" })
    h.fee.mockResolvedValue(1)
    h.fake.tables.role_service_rates = { error: { message: "x" } }
    expect((await GET(reqOf("GET"), ctx())).status).toBe(500)
    h.fake.tables.role_service_rates = { data: [] }
    h.cfg.mockRejectedValue(new Error("x"))
    res = await GET(reqOf("GET"), ctx())
    expect(res.status).toBe(500)
  })
})

describe("PUT /api/admin/roles/[id]/rates", () => {
  it("403 CRON bypass; 403 system roles, no rpc", async () => {
    h.verify.mockResolvedValue({ isAdmin: true })
    expect((await put({ changes: [], reason: "tune" })).status).toBe(403)
    h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
    expect((await put({ changes: [], reason: "tune" }, DEALER)).status).toBe(403)
    expect((await put({ changes: [], reason: "tune" }, USER)).status).toBe(403)
    expect(h.fake.calls.rpc).toEqual([])
  })
  it("404 unknown role; 400 bad reason, unknown key, bad value", async () => {
    expect((await put({ changes: [], reason: "tune" }, "77777777-7777-4777-8777-777777777777")).status).toBe(404)
    expect((await put({ changes: [], reason: "" })).status).toBe(400)
    expect((await put({ changes: [{ service_key: "bogus:x", value: 1 }], reason: "tune" })).status).toBe(400)
    expect((await put({ changes: [{ service_key: "airtime_fee:mtn", value: 101 }], reason: "tune" })).status).toBe(400)
    expect(h.fake.calls.rpc).toEqual([])
  })
  it("calls the function with the validated changes", async () => {
    h.fake.rpc.admin_role_set_rates = { data: 2 }
    const res = await put({ changes: [{ service_key: "airtime_fee:mtn", value: 2.555 }, { service_key: "cashback_share:bills", value: null }], reason: "tune" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ changed: 2 })
    expect(h.fake.calls.rpc[0]).toEqual({
      name: "admin_role_set_rates",
      args: {
        p_actor: ADMIN,
        p_reason: "tune",
        p_role_id: ID,
        p_changes: [{ service_key: "airtime_fee:mtn", value: 2.56 }, { service_key: "cashback_share:bills", value: null }],
      },
    })
  })
  it("rpc failures return 500 without detail", async () => {
    h.fake.rpc.admin_role_set_rates = { error: { message: "secret" } }
    const res = await put({ changes: [], reason: "tune" })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret")
  })
})
