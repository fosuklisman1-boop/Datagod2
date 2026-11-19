import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeFake, reqOf, ctx, ADMIN, ID, role } from "../../test-utils"

const h = vi.hoisted(() => ({ verify: vi.fn(), fake: null as unknown as ReturnType<typeof makeFake> }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: h.verify }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake.db }))
import { NextResponse } from "next/server"
import { GET, PUT } from "./route"

const P1 = "aaaa1111-1111-4111-8111-111111111111"
const P2 = "bbbb2222-2222-4222-8222-222222222222"
const SYS = "44444444-4444-4444-8444-444444444444"
const DEALER = "55555555-5555-4555-8555-555555555555"
const USER = "66666666-6666-4666-8666-666666666666"

const pkgRow = (id: string, price: number, cost: number | null, extra: Record<string, unknown> = {}) => ({
  id, network: "MTN", name: `${id.slice(0, 4)} 1GB`, price, dealer_price: null, cost_price: cost, is_available: true, ...extra,
})

beforeEach(() => {
  h.fake = makeFake()
  h.verify.mockReset()
  h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
  h.fake.tables.roles = {
    data: [
      role(ID, "gold", 30),
      role(USER, "user", 0, { is_system: true }),
      role(DEALER, "dealer", 10, { is_system: true }),
      role(SYS, "sub_agent", null, { is_system: true }),
    ],
  }
  h.fake.tables.packages = ({ filters }) => {
    const idList = filters.find((f) => f[0] === "in" && f[1] === "id")?.[2] as string[] | undefined
    const all = [pkgRow(P1, 10, 8), pkgRow(P2, 20, null)]
    return { data: idList ? all.filter((p) => idList.includes(p.id)).map((p) => ({ id: p.id, cost_price: p.cost_price })) : all }
  }
  h.fake.tables.role_package_prices = { data: [{ role_id: ID, package_id: P1, price: 9 }] }
})

const put = (body: unknown, id = ID) => PUT(reqOf("PUT", body), ctx(id))

describe("GET /api/admin/roles/[id]/prices", () => {
  it("401 non-admin; 403 CRON bypass", async () => {
    h.verify.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await GET(reqOf("GET"), ctx())).status).toBe(401)
    h.verify.mockResolvedValue({ isAdmin: true })
    expect((await GET(reqOf("GET"), ctx())).status).toBe(403)
  })
  it("400 bad id, 404 unknown role", async () => {
    expect((await GET(reqOf("GET"), ctx("nope"))).status).toBe(400)
    expect((await GET(reqOf("GET"), ctx("77777777-7777-4777-8777-777777777777"))).status).toBe(404)
  })
  it("lists packages with the role's own price and the effective price", async () => {
    const res = await GET(reqOf("GET"), ctx())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.editable).toBe(true)
    expect(body.packages).toHaveLength(2)
    const a = body.packages.find((p: { id: string }) => p.id === P1)
    expect(a).toMatchObject({ price: 10, cost_price: 8, role_price: 9, effective_price: 9, is_available: true })
    const b = body.packages.find((p: { id: string }) => p.id === P2)
    expect(b).toMatchObject({ price: 20, cost_price: null, role_price: null })
    expect(b.effective_price).toBe(20)
  })
  it("editable is false for sub_agent", async () => {
    const body = await (await GET(reqOf("GET"), ctx(SYS))).json()
    expect(body.editable).toBe(false)
  })
  it("500 with nothing partial when any read fails", async () => {
    h.fake.tables.role_package_prices = { error: { message: "secret detail" } }
    const res = await GET(reqOf("GET"), ctx())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Something went wrong" })
    h.fake.tables.role_package_prices = { data: [] }
    h.fake.tables.packages = { error: { message: "x" } }
    expect((await GET(reqOf("GET"), ctx())).status).toBe(500)
  })
  it("500 when the package list may be truncated", async () => {
    h.fake.tables.packages = { data: Array.from({ length: 1000 }, (_, i) => pkgRow(`p${i}`, 5, 1)) }
    expect((await GET(reqOf("GET"), ctx())).status).toBe(500)
  })
})

describe("PUT /api/admin/roles/[id]/prices", () => {
  it("401 / 403 CRON bypass, no rpc", async () => {
    h.verify.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await put({ changes: [], reason: "tune" })).status).toBe(401)
    h.verify.mockResolvedValue({ isAdmin: true })
    expect((await put({ changes: [], reason: "tune" })).status).toBe(403)
    expect(h.fake.calls.rpc).toEqual([])
  })
  it("403 for sub_agent before validating", async () => {
    const res = await put({ changes: "garbage", reason: "x" }, SYS)
    expect(res.status).toBe(403)
    expect(h.fake.calls.rpc).toEqual([])
  })
  it("404 unknown role", async () => {
    expect((await put({ changes: [], reason: "tune" }, "77777777-7777-4777-8777-777777777777")).status).toBe(404)
  })
  it("400 for a bad reason, a non-array, and an unknown package", async () => {
    expect((await put({ changes: [], reason: "" })).status).toBe(400)
    expect((await put({ changes: "x", reason: "tune" })).status).toBe(400)
    const res = await put({ changes: [{ package_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", price: 5 }], reason: "tune" })
    expect(res.status).toBe(400)
    expect(h.fake.calls.rpc).toEqual([])
  })
  it("passes exactly the listed cells to the function", async () => {
    h.fake.rpc.admin_role_set_prices = { data: 1 }
    const res = await put({ changes: [{ package_id: P1, price: 9.5 }], reason: "tune", loss_override: false })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ changed: 1 })
    expect(h.fake.calls.rpc).toEqual([
      {
        name: "admin_role_set_prices",
        args: { p_actor: ADMIN, p_reason: "tune", p_role_id: ID, p_changes: [{ package_id: P1, price: 9.5 }], p_loss_override: false },
      },
    ])
    // cost read only for the requested ids
    const inFilter = h.fake.calls.chains.packages.flat().find((f) => f[0] === "in")
    expect(inFilter).toEqual(["in", "id", [P1]])
  })
  it("null deletes the role row", async () => {
    await put({ changes: [{ package_id: P2, price: null }], reason: "tune" })
    expect(h.fake.calls.rpc[0].args.p_changes).toEqual([{ package_id: P2, price: null }])
    expect(h.fake.calls.rpc[0].args.p_loss_override).toBe(false)
  })
  it("409 below cost without override, listing ids, no rpc", async () => {
    const res = await put({ changes: [{ package_id: P1, price: 7 }], reason: "tune" })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "Some prices are below cost.", below_cost: [P1] })
    expect(h.fake.calls.rpc).toEqual([])
  })
  it("a truthy non-true loss_override does not count", async () => {
    const res = await put({ changes: [{ package_id: P1, price: 7 }], reason: "tune", loss_override: "yes" })
    expect(res.status).toBe(409)
  })
  it("below cost with override true calls the function with p_loss_override true", async () => {
    h.fake.rpc.admin_role_set_prices = { data: 1 }
    const res = await put({ changes: [{ package_id: P1, price: 7 }], reason: "tune", loss_override: true })
    expect(res.status).toBe(200)
    expect(h.fake.calls.rpc[0].args.p_loss_override).toBe(true)
  })
  it("500 when costs cannot be read; rpc errors map without leaking detail", async () => {
    h.fake.tables.packages = { error: { message: "boom" } }
    expect((await put({ changes: [{ package_id: P1, price: 9 }], reason: "tune" })).status).toBe(500)
    expect(h.fake.calls.rpc).toEqual([])
    h.fake.tables.packages = { data: [{ id: P1, cost_price: 8 }] }
    h.fake.rpc.admin_role_set_prices = { error: { message: "weird db detail" } }
    const res = await put({ changes: [{ package_id: P1, price: 9 }], reason: "tune" })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("weird")
  })
  it("maps a racing below-cost error to 409", async () => {
    h.fake.tables.packages = { data: [{ id: P1, cost_price: 5 }] }
    h.fake.rpc.admin_role_set_prices = { error: { message: "price 7 is below cost 8 for package x (loss override required)" } }
    expect((await put({ changes: [{ package_id: P1, price: 7 }], reason: "tune" })).status).toBe(409)
  })
})
