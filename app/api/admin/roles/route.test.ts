import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeFake, reqOf, ADMIN, ID, role } from "./test-utils"

const h = vi.hoisted(() => ({ verify: vi.fn(), fake: null as unknown as ReturnType<typeof makeFake> }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: h.verify }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake.db }))
import { NextResponse } from "next/server"
import { GET, POST } from "./route"

const FULL = (id: string, slug: string, rank: number | null) => ({
  ...role(id, slug, rank), name: slug, description: null, badge_color: null, icon: null, theme: {},
})

beforeEach(() => {
  h.fake = makeFake()
  h.verify.mockReset()
  h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
})

describe("auth", () => {
  it("401 for non-admin on GET and POST", async () => {
    h.verify.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await GET(reqOf("GET"))).status).toBe(401)
    expect((await POST(reqOf("POST", {}))).status).toBe(401)
  })
  it("403 for a non-admin user", async () => {
    h.verify.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Admin access required" }, { status: 403 }) })
    expect((await GET(reqOf("GET"))).status).toBe(403)
  })
  it("403 Admin user required for the CRON bypass (no userId), GET and POST, with no db access", async () => {
    h.verify.mockResolvedValue({ isAdmin: true })
    for (const res of [await GET(reqOf("GET")), await POST(reqOf("POST", { slug: "gold" }))]) {
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: "Admin user required" })
    }
    expect(h.fake.calls.from).toEqual([])
    expect(h.fake.calls.rpc).toEqual([])
  })
})

describe("GET /api/admin/roles", () => {
  it("combines roles, stats and the active package count, including archived", async () => {
    h.fake.tables.roles = { data: [FULL("r1", "dealer", 10), { ...FULL("r2", "old", 20), archived_at: "2026-01-01" }] }
    h.fake.tables.packages = { count: 42 }
    h.fake.rpc.admin_role_stats = { data: [{ role_id: "r1", member_count: 7, priced_count: 3 }] }
    const res = await GET(reqOf("GET"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.package_total).toBe(42)
    expect(body.roles).toHaveLength(2)
    expect(body.roles[0]).toMatchObject({ slug: "dealer", member_count: 7, priced_count: 3 })
    expect(body.roles[1]).toMatchObject({ slug: "old", member_count: 0, priced_count: 0 })
    expect(h.fake.calls.chains.packages[0]).toContainEqual(["eq", "active", true])
  })
  it("500 when any read fails, without detail", async () => {
    h.fake.tables.roles = { data: [FULL("r1", "dealer", 10)] }
    h.fake.tables.packages = { count: 1 }
    h.fake.rpc.admin_role_stats = { error: { message: "boom secret" } }
    const res = await GET(reqOf("GET"))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret")
    h.fake.rpc.admin_role_stats = { data: [] }
    h.fake.tables.packages = { error: { message: "x" } }
    expect((await GET(reqOf("GET"))).status).toBe(500)
  })
})

describe("POST /api/admin/roles", () => {
  const good = { slug: "gold", name: "Gold", rank: 30, reason: "new tier" }
  beforeEach(() => {
    h.fake.tables.roles = { data: [role("rd", "dealer", 10), role("ru", "user", 0)] }
    h.fake.rpc.admin_role_create = { data: ID }
  })
  it("refuses the admin slug and never calls the rpc", async () => {
    const res = await POST(reqOf("POST", { ...good, slug: "admin" }))
    expect(res.status).toBe(400)
    expect(h.fake.calls.rpc).toEqual([])
  })
  it("refuses a duplicate of an archived role slug", async () => {
    h.fake.tables.roles = { data: [role("rx", "gold", 5, { archived_at: "2026-01-01" })] }
    expect((await POST(reqOf("POST", good))).status).toBe(400)
  })
  it("201 { id } and passes actor, reason, clone id through the rpc", async () => {
    const res = await POST(reqOf("POST", { ...good, cloneFrom: "dealer" }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: ID })
    expect(h.fake.calls.rpc[0]).toEqual({
      name: "admin_role_create",
      args: { p_actor: ADMIN, p_reason: "new tier", p_slug: "gold", p_name: "Gold", p_rank: 30, p_clone_from: "rd" },
    })
  })
  it("accepts clone_from as the documented body key", async () => {
    const res = await POST(reqOf("POST", { ...good, clone_from: "dealer" }))
    expect(res.status).toBe(201)
    expect(h.fake.calls.rpc[0].args.p_clone_from).toBe("rd")
  })
  it("null clone when absent; rank collision from the rpc maps to 409", async () => {
    h.fake.rpc.admin_role_create = { error: { message: "rank 30 is already in use" } }
    const res = await POST(reqOf("POST", good))
    expect(res.status).toBe(409)
    expect(h.fake.calls.rpc[0].args.p_clone_from).toBeNull()
  })
  it("500 on unknown rpc error and when roles cannot be read", async () => {
    h.fake.rpc.admin_role_create = { error: { message: "connection refused to db.internal" } }
    const res = await POST(reqOf("POST", good))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("internal")
    h.fake.tables.roles = { error: { message: "x" } }
    expect((await POST(reqOf("POST", good))).status).toBe(500)
  })
})
