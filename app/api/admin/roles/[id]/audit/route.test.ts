import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeFake, reqOf, ctx, ADMIN, ID, role } from "../../test-utils"

const h = vi.hoisted(() => ({ verify: vi.fn(), fake: null as unknown as ReturnType<typeof makeFake> }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: h.verify }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake.db }))
import { NextResponse } from "next/server"
import { GET } from "./route"

const url = (q = "") => `http://localhost/api/admin/roles/${ID}/audit${q}`
const one = (over: Record<string, unknown> = {}) => ({
  id: 1, actor_id: "u1", action: "update", before: null, after: null, reason: "r", loss_override: false,
  created_at: "2026-11-01T00:00:00Z", ...over,
})

beforeEach(() => {
  h.fake = makeFake()
  h.verify.mockReset()
  h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
  h.fake.tables.roles = { data: [role(ID, "gold", 30)] }
  h.fake.tables.role_audit_log = {
    data: [
      one({ id: 2, reason: "basics edit", created_at: "2026-11-02T10:00:00Z", after: { name: "x" } }),
      one({ id: 1, action: "create", reason: "new", loss_override: true, created_at: "2026-11-01T10:00:00Z", after: { slug: "gold" } }),
    ],
  }
  h.fake.tables.admin_audit_log = {
    data: [
      { id: "a1", admin_id: "u2", action: "user_role_change", target_user_id: "t1", old_value: { role: "user" }, new_value: { role: "gold" }, created_at: "2026-11-03T10:00:00Z" },
    ],
  }
  h.fake.tables.users = { data: [{ id: "u1", email: "one@x.com" }, { id: "u2", email: "two@x.com" }] }
})

describe("GET /api/admin/roles/[id]/audit", () => {
  it("401 / 403 CRON bypass", async () => {
    h.verify.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await GET(reqOf("GET", undefined, url()), ctx())).status).toBe(401)
    h.verify.mockResolvedValue({ isAdmin: true })
    expect((await GET(reqOf("GET", undefined, url()), ctx())).status).toBe(403)
    expect(h.fake.calls.from).toEqual([])
  })
  it("merges both sources newest first with actor emails and no phone numbers", async () => {
    const res = await GET(reqOf("GET", undefined, url()), ctx())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.page).toBe(1)
    expect(body.has_more).toBe(false)
    expect(body.entries.map((e: { at: string }) => e.at)).toEqual(["2026-11-03T10:00:00Z", "2026-11-02T10:00:00Z", "2026-11-01T10:00:00Z"])
    expect(body.entries[0]).toMatchObject({ actor_id: "u2", actor_email: "two@x.com", action: "user_role_change" })
    expect(body.entries[2]).toMatchObject({ action: "create", reason: "new", loss_override: true })
    expect(JSON.stringify(body)).not.toMatch(/phone/i)
    expect(h.fake.calls.chains.admin_audit_log[0]).toContainEqual(["eq", "action", "user_role_change"])
    expect(JSON.stringify(h.fake.calls.chains.admin_audit_log[0])).toContain("old_value->>role.eq.gold")
  })
  it("paginates 50 per page with has_more", async () => {
    h.fake.tables.role_audit_log = {
      data: Array.from({ length: 60 }, (_, i) => one({ id: i, created_at: new Date(Date.UTC(2026, 10, 1, 0, 0, 60 - i)).toISOString() })),
    }
    h.fake.tables.admin_audit_log = { data: [] }
    const p1 = await (await GET(reqOf("GET", undefined, url()), ctx())).json()
    expect(p1.entries).toHaveLength(50)
    expect(p1.has_more).toBe(true)
    const p2 = await (await GET(reqOf("GET", undefined, url("?page=2")), ctx())).json()
    expect(p2.entries).toHaveLength(10)
    expect(p2.has_more).toBe(false)
  })
  it("resolves emails in chunks of at most 500 ids", async () => {
    h.fake.tables.role_audit_log = {
      data: Array.from({ length: 50 }, (_, i) => one({ id: i, actor_id: `a${i}`, created_at: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString() })),
    }
    h.fake.tables.admin_audit_log = { data: [] }
    await GET(reqOf("GET", undefined, url()), ctx())
    expect(h.fake.calls.chains.users.length).toBeGreaterThan(0)
    for (const chain of h.fake.calls.chains.users) {
      const inCall = chain.find((c) => c[0] === "in") as [string, string, string[]]
      expect(inCall[2].length).toBeLessThanOrEqual(500)
    }
  })
  it("fails closed with 500 when any read fails", async () => {
    h.fake.tables.admin_audit_log = { error: { message: "x" } }
    const res = await GET(reqOf("GET", undefined, url()), ctx())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Something went wrong" })
    h.fake.tables.admin_audit_log = { data: [] }
    h.fake.tables.role_audit_log = { error: { message: "x" } }
    expect((await GET(reqOf("GET", undefined, url()), ctx())).status).toBe(500)
    h.fake.tables.role_audit_log = { data: [one()] }
    h.fake.tables.users = { error: { message: "x" } }
    expect((await GET(reqOf("GET", undefined, url()), ctx())).status).toBe(500)
  })
  it("404 for an unknown role", async () => {
    h.fake.tables.roles = { data: [] }
    expect((await GET(reqOf("GET", undefined, url()), ctx())).status).toBe(404)
  })
})
