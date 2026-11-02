import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { ADMIN_ID, createFakeDb, USER_ID, type FakeDb, type FakeQuery, type GateMode } from "@/lib/admin-users/test-fake-db"

const h = vi.hoisted(() => ({ gate: "admin" as GateMode, fake: null as unknown as FakeDb, role: "user", parent: null as string | null, meta: [] as any[] }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => (await import("@/lib/admin-users/test-fake-db")).fakeVerify(h.gate)),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async () => ({ sent: 0, removed: 0 })) }))

import { POST as RAW_POST } from "./route"

const POST = async (body: unknown) =>
  (await RAW_POST(new NextRequest("http://x/api/admin/users/update-role", { method: "POST", body: JSON.stringify(body) })))!

beforeEach(() => {
  h.gate = "admin"
  h.role = "user"
  h.parent = null
  h.meta = []
  h.fake = createFakeDb({
    tables: {
      users: (q: FakeQuery) => {
        if (q.kind === "update") { h.role = (q.payload as any).role; return { data: null, error: null } }
        return { data: { role: h.role }, error: null }
      },
      user_shops: () => ({ data: { id: "shop-1", parent_shop_id: h.parent }, error: null }),
      shop_packages: () => ({ data: [{ id: "sp1", package_id: "p1", profit_margin: 1 }], error: null }),
      packages: () => ({ data: [{ id: "p1", price: 10, dealer_price: 8 }], error: null }),
      admin_audit_log: () => ({ data: null, error: null }),
    },
  })
  ;(h.fake.db.auth.admin as any).updateUserById = async (id: string, attrs: unknown) => { h.meta.push({ id, attrs }); return { error: null } }
})

describe("POST /api/admin/users/update-role (shared changeUserRole)", () => {
  it("keeps its gate: 403 for non-admins; the CRON bypass still works, without an audit row", async () => {
    h.gate = "forbidden"
    expect((await POST({ userId: USER_ID, role: "dealer" })).status).toBe(403)
    h.gate = "cron"
    expect((await POST({ userId: USER_ID, role: "admin" })).status).toBe(200)
    expect(h.fake.ofTable("admin_audit_log")).toHaveLength(0)
  })

  it("400s on a missing or unknown role", async () => {
    expect((await POST({ userId: USER_ID })).status).toBe(400)
    expect((await POST({ userId: USER_ID, role: "root" })).status).toBe(400)
  })

  it("refuses dealer for a sub-agent", async () => {
    h.parent = "parent-shop"
    const res = await POST({ userId: USER_ID, newRole: "dealer" })
    expect(res.status).toBe(400)
    expect(h.role).toBe("user")
  })

  it("upgrades to dealer: role, margins, metadata, audit row", async () => {
    const res = await POST({ userId: USER_ID, newRole: "dealer" })
    expect(await res.json()).toMatchObject({ success: true, newRole: "dealer", changed: true })
    expect(h.role).toBe("dealer")
    expect(h.fake.ofTable("shop_packages").find((q) => q.kind === "update")!.payload).toEqual({ profit_margin: 3 })
    expect(h.meta).toEqual([{ id: USER_ID, attrs: { user_metadata: { role: "dealer" } } }])
    expect(h.fake.ofTable("admin_audit_log")[0].payload).toEqual([{ admin_id: ADMIN_ID, action: "user_role_change", target_user_id: USER_ID,
      old_value: { role: "user" }, new_value: { role: "dealer" } }])
  })

  it("setting the current role again changes nothing (no second margin bump)", async () => {
    h.role = "dealer"
    expect(await (await POST({ userId: USER_ID, role: "dealer" })).json()).toMatchObject({ success: true, changed: false })
    expect(h.fake.ofTable("shop_packages")).toHaveLength(0)
    expect(h.fake.ofTable("admin_audit_log")).toHaveLength(0)
  })
})
