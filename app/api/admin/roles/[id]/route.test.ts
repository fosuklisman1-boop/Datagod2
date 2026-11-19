import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeFake, reqOf, ctx, ADMIN, ID, role } from "../test-utils"

const h = vi.hoisted(() => ({ verify: vi.fn(), fake: null as unknown as ReturnType<typeof makeFake> }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: h.verify }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake.db }))
import { NextResponse } from "next/server"
import { PATCH } from "./route"

const AID = "33333333-3333-4333-8333-333333333333"

beforeEach(() => {
  h.fake = makeFake()
  h.verify.mockReset()
  h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
  h.fake.tables.roles = { data: [role(ID, "gold", 30), role(AID, "admin", 100, { is_system: true })] }
})

describe("PATCH /api/admin/roles/[id]", () => {
  it("401 non-admin; 403 CRON bypass", async () => {
    h.verify.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await PATCH(reqOf("PATCH", { name: "Gold" }), ctx())).status).toBe(401)
    h.verify.mockResolvedValue({ isAdmin: true })
    const res = await PATCH(reqOf("PATCH", { name: "Gold" }), ctx())
    expect(res.status).toBe(403)
    expect(h.fake.calls.rpc).toEqual([])
  })
  it("400 for a non-uuid id and for an invalid patch", async () => {
    expect((await PATCH(reqOf("PATCH", { name: "Gold" }), ctx("nope"))).status).toBe(400)
    expect((await PATCH(reqOf("PATCH", { bogus: 1 }), ctx())).status).toBe(400)
  })
  it("refuses admin", async () => {
    expect((await PATCH(reqOf("PATCH", { name: "Boss" }), ctx(AID))).status).toBe(400)
    expect(h.fake.calls.rpc).toEqual([])
  })
  it("calls the rpc with the basics edit reason", async () => {
    const res = await PATCH(reqOf("PATCH", { name: "Gold Plus", theme: { skin: "dealer" } }), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(h.fake.calls.rpc[0]).toEqual({
      name: "admin_role_update",
      args: { p_actor: ADMIN, p_reason: "basics edit", p_role_id: ID, p_patch: { name: "Gold Plus", theme: { skin: "dealer" } } },
    })
  })
  it("sub_agent may not change theme but may change name", async () => {
    const SID = "22222222-2222-4222-8222-222222222222"
    h.fake.tables.roles = { data: [role(SID, "sub_agent", null, { is_system: true })] }
    expect((await PATCH(reqOf("PATCH", { theme: { skin: "dealer" } }), ctx(SID))).status).toBe(400)
    expect((await PATCH(reqOf("PATCH", { name: "Agent" }), ctx(SID))).status).toBe(200)
  })
  it("404 for an unknown role", async () => {
    h.fake.tables.roles = { data: [] }
    expect((await PATCH(reqOf("PATCH", { name: "Gold" }), ctx())).status).toBe(404)
  })
  it("maps unknown rpc errors to a bare 500", async () => {
    h.fake.rpc.admin_role_update = { error: { message: "pg exploded" } }
    const res = await PATCH(reqOf("PATCH", { name: "Gold" }), ctx())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Something went wrong" })
  })
})
