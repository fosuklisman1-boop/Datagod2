import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeFake, reqOf, ctx, ADMIN, ID, role } from "../../test-utils"

const h = vi.hoisted(() => ({ verify: vi.fn(), fake: null as unknown as ReturnType<typeof makeFake>, reset: vi.fn() }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: h.verify }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake.db }))
vi.mock("@/lib/roles/permissions-repo", () => ({ __resetRightsCache: h.reset }))
import { NextResponse } from "next/server"
import { ALL_CAPABILITIES as CAPABILITIES } from "@/lib/roles/capabilities"
import { GET, PUT } from "./route"

const ADM = "44444444-4444-4444-8444-444444444444"
const SUB = "55555555-5555-4555-8555-555555555555"
const CAP = CAPABILITIES[0]
const CAP2 = CAPABILITIES[1]

beforeEach(() => {
  h.fake = makeFake()
  h.reset.mockReset()
  h.verify.mockReset()
  h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
  h.fake.tables.roles = {
    data: [role(ID, "gold", 30), role(ADM, "admin", 100, { is_system: true }), role(SUB, "sub_agent", null, { is_system: true })],
  }
  h.fake.tables.role_permissions = { data: [{ capability: CAP }, { capability: "made.up" }] }
  h.fake.rpc.admin_role_stats = { data: [{ role_id: ID, member_count: 7, priced_count: 3 }, { role_id: ADM, member_count: 1, priced_count: 0 }, { role_id: SUB, member_count: 2, priced_count: 0 }] }
})

const put = (body: unknown, id = ID) => PUT(reqOf("PUT", body), ctx(id))

describe("GET /api/admin/roles/[id]/permissions", () => {
  it("401 non-admin; 400 bad id; 404 unknown role", async () => {
    h.verify.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await GET(reqOf("GET"), ctx())).status).toBe(401)
    h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
    expect((await GET(reqOf("GET"), ctx("nope"))).status).toBe(400)
    expect((await GET(reqOf("GET"), ctx("77777777-7777-4777-8777-777777777777"))).status).toBe(404)
  })
  it("returns known capabilities (unknown dropped) and the member count", async () => {
    const res = await GET(reqOf("GET"), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ editable: true, capabilities: [CAP], member_count: 7 })
  })
  it("editable false for admin and sub_agent", async () => {
    expect((await (await GET(reqOf("GET"), ctx(ADM))).json()).editable).toBe(false)
    expect((await (await GET(reqOf("GET"), ctx(SUB))).json()).editable).toBe(false)
  })
  it("500 when a read fails or the stats row is missing", async () => {
    h.fake.tables.role_permissions = { error: { message: "x" } }
    expect((await GET(reqOf("GET"), ctx())).status).toBe(500)
    h.fake.tables.role_permissions = { data: [] }
    h.fake.rpc.admin_role_stats = { error: { message: "x" } }
    expect((await GET(reqOf("GET"), ctx())).status).toBe(500)
    h.fake.rpc.admin_role_stats = { data: [] }
    expect((await GET(reqOf("GET"), ctx())).status).toBe(500)
  })
})

describe("PUT /api/admin/roles/[id]/permissions", () => {
  it("403 CRON bypass; 403 admin and sub_agent; no rpc", async () => {
    h.verify.mockResolvedValue({ isAdmin: true })
    expect((await put({ capabilities: [], reason: "tune" })).status).toBe(403)
    h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
    expect((await put({ capabilities: [], reason: "tune" }, ADM)).status).toBe(403)
    expect((await put({ capabilities: [], reason: "tune" }, SUB)).status).toBe(403)
    expect(h.fake.calls.rpc).toEqual([])
  })
  it("404 unknown role", async () => {
    expect((await put({ capabilities: [], reason: "tune" }, "77777777-7777-4777-8777-777777777777")).status).toBe(404)
  })
  it("400 for an unknown capability and a bad reason", async () => {
    const res = await put({ capabilities: [CAP, "made.up"], reason: "tune" })
    expect(res.status).toBe(400)
    expect((await put({ capabilities: [CAP], reason: "" })).status).toBe(400)
    expect(h.fake.calls.rpc).toEqual([])
    expect(h.reset).not.toHaveBeenCalled()
  })
  it("saves, calls the function and clears the rights cache", async () => {
    const res = await put({ capabilities: [CAP, CAP2, CAP], reason: "tune" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(h.fake.calls.rpc[0]).toEqual({
      name: "admin_role_set_permissions",
      args: { p_actor: ADMIN, p_reason: "tune", p_role_id: ID, p_caps: [CAP, CAP2] },
    })
    expect(h.reset).toHaveBeenCalledTimes(1)
  })
  it("an empty list is valid", async () => {
    expect((await put({ capabilities: [], reason: "tune" })).status).toBe(200)
    expect(h.fake.calls.rpc[0].args.p_caps).toEqual([])
  })
  it("rpc failure is a 500 without detail and does not clear the cache", async () => {
    h.fake.rpc.admin_role_set_permissions = { error: { message: "secret" } }
    const res = await put({ capabilities: [CAP], reason: "tune" })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret")
    expect(h.reset).not.toHaveBeenCalled()
  })
})
