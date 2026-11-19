import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeFake, reqOf, ctx, ADMIN, ID, role } from "../../test-utils"

const h = vi.hoisted(() => ({ verify: vi.fn(), fake: null as unknown as ReturnType<typeof makeFake> }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: h.verify }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake.db }))
import { NextResponse } from "next/server"
import { POST } from "./route"

beforeEach(() => {
  h.fake = makeFake()
  h.verify.mockReset()
  h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
  h.fake.tables.roles = { data: [role(ID, "gold", 30)] }
  h.fake.tables.users = { count: 0 }
})

describe("POST /api/admin/roles/[id]/archive", () => {
  it("401 / 403 CRON bypass", async () => {
    h.verify.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await POST(reqOf("POST", { reason: "retire" }), ctx())).status).toBe(401)
    h.verify.mockResolvedValue({ isAdmin: true })
    expect((await POST(reqOf("POST", { reason: "retire" }), ctx())).status).toBe(403)
    expect(h.fake.calls.rpc).toEqual([])
  })
  it("409 with the member count, before the rpc", async () => {
    h.fake.tables.users = { count: 4 }
    const res = await POST(reqOf("POST", { reason: "retire" }), ctx())
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "Move its 4 members first." })
    expect(h.fake.calls.rpc).toEqual([])
    expect(h.fake.calls.chains.users[0]).toContainEqual(["eq", "role", "gold"])
  })
  it("maps the SQL members error to the same 409", async () => {
    h.fake.rpc.admin_role_archive = { error: { message: "role has members" } }
    expect((await POST(reqOf("POST", { reason: "retire" }), ctx())).status).toBe(409)
  })
  it("archives with actor and reason", async () => {
    const res = await POST(reqOf("POST", { reason: "retire" }), ctx())
    expect(res.status).toBe(200)
    expect(h.fake.calls.rpc[0]).toEqual({ name: "admin_role_archive", args: { p_actor: ADMIN, p_reason: "retire", p_role_id: ID } })
  })
  it("500 when the member count cannot be read; 400 for a bad reason", async () => {
    h.fake.tables.users = { error: { message: "x" } }
    expect((await POST(reqOf("POST", { reason: "retire" }), ctx())).status).toBe(500)
    expect((await POST(reqOf("POST", { reason: "" }), ctx())).status).toBe(400)
  })
})
