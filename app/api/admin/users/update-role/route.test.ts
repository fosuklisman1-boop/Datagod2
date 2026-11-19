import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { ADMIN_ID, createFakeDb, USER_ID, type FakeDb, type FakeQuery, type GateMode } from "@/lib/admin-users/test-fake-db"

type Audit = { admin_id: string; action: string; target_user_id: string; old_value: any; new_value: any; created_at: number }
const h = vi.hoisted(() => ({
  gate: "admin" as GateMode,
  fake: null as unknown as FakeDb,
  role: "user" as string | null,
  /** Role another request writes between our read and our update (the race). */
  raceTo: null as string | null,
  /** The user row is deleted between our read and our write. */
  gone: false,
  shop: { id: "shop-1", parent_shop_id: null as string | null } as { id: string; parent_shop_id: string | null } | null,
  shopError: false,
  margins: {} as Record<string, number>,
  audit: [] as Audit[],
  meta: [] as any[],
  clock: 0,
  rolesError: false,
  packagesError: false,
  rolePrices: [] as Array<{ role_id: string; package_id: string; price: number }>,
  /** Value of CUSTOM_ROLE_ASSIGNMENT_ENABLED for this test (the real flag ships false). */
  customEnabled: true,
}))
vi.mock("@/lib/roles/flags", () => ({
  get CUSTOM_ROLE_ASSIGNMENT_ENABLED() { return h.customEnabled },
}))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => (await import("@/lib/admin-users/test-fake-db")).fakeVerify(h.gate)),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async () => ({ sent: 0, removed: 0 })) }))

import { sendPushToUser } from "@/lib/push-service"
import { POST as RAW_POST } from "./route"
import { changeUserRole } from "@/lib/admin-users/account-ops"

const POST = async (body: unknown) =>
  (await RAW_POST(new NextRequest("http://x/api/admin/users/update-role", { method: "POST", body: JSON.stringify(body) })))!

// Packages: p1 role 10 / dealer 8 (diff 2), p2 role 5 / dealer 4.5 (diff 0.5), p3 dealer price 0 (no dealer price).
const PACKAGES = [{ id: "p1", price: 10, dealer_price: 8 }, { id: "p2", price: 5, dealer_price: 4.5 }, { id: "p3", price: 7, dealer_price: 0 }]
const SHOP_PACKAGES = [{ id: "sp1", package_id: "p1" }, { id: "sp2", package_id: "p2" }, { id: "sp3", package_id: "p3" }]

// Roles: user rank 1, dealer rank 2, custom "super" rank 3 above dealer, admin off-ladder, "old_vip" archived.
const ROLES = [
  { id: "r-user", slug: "user", name: "Standard user", rank: 1, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", name: "Dealer", rank: 2, is_system: true, archived_at: null },
  { id: "r-super", slug: "super", name: "Super Agent", rank: 3, is_system: false, archived_at: null },
  { id: "r-old", slug: "old_vip", name: "Old VIP", rank: 4, is_system: false, archived_at: "2026-01-01" },
  { id: "r-admin", slug: "admin", name: "Admin", rank: null, is_system: true, archived_at: null },
]

/** Applies PostgREST's or=(role.is.null,role.neq.X) to the stored role. */
function orMatches(q: FakeQuery, role: string | null) {
  const or = q.op("or")?.[1] as string | undefined
  if (!or) return true
  const notIn = /^role\.is\.null,role\.not\.in\.\(([^)]*)\)$/.exec(or)
  if (notIn) return role === null || !notIn[1].split(",").includes(role)
  return or.split(",").some((cond) => {
    const [, op, val] = cond.split(".")
    return op === "is" ? role === null : op === "neq" ? role !== null && role !== val : false
  })
}

beforeEach(() => {
  h.gate = "admin"
  h.role = "user"
  h.raceTo = null
  h.gone = false
  h.shop = { id: "shop-1", parent_shop_id: null }
  h.shopError = false
  h.margins = { sp1: 1, sp2: 1, sp3: 1 }
  h.audit = []
  h.meta = []
  h.clock = 0
  h.rolesError = false
  h.packagesError = false
  h.customEnabled = true
  h.rolePrices = [{ role_id: "r-super", package_id: "p1", price: 9.5 }, { role_id: "r-super", package_id: "p2", price: 4 }]
  vi.mocked(sendPushToUser).mockClear()
  h.fake = createFakeDb({
    tables: {
      users: (q: FakeQuery) => {
        if (q.kind === "update") {
          if (h.raceTo === "__gone__") { h.gone = true; h.raceTo = null }
          if (h.gone) return { data: [], error: null }
          if (h.raceTo !== null) { h.role = h.raceTo; h.raceTo = null }
          if (!orMatches(q, h.role)) return { data: [], error: null }
          // SQL NULL semantics: `role <> 'admin'` is NULL (row excluded) when role is NULL.
          if (q.op("neq")?.[1] === "role" && (h.role === null || h.role === q.op("neq")?.[2])) return { data: [], error: null }
          h.role = (q.payload as any).role
          return { data: [{ id: USER_ID }], error: null }
        }
        return { data: h.gone ? null : { role: h.role }, error: null }
      },
      user_shops: () => (h.shopError ? { data: null, error: { message: "timeout" } } : { data: h.shop, error: null }),
      shop_packages: (q: FakeQuery) => {
        if (q.kind === "update") { h.margins[q.filter("id") as string] = (q.payload as any).profit_margin; return { data: null, error: null } }
        return { data: SHOP_PACKAGES.map((sp) => ({ ...sp, profit_margin: h.margins[sp.id] })), error: null }
      },
      packages: () => (h.packagesError ? { data: null, error: { message: "boom" } } : { data: PACKAGES, error: null }),
      roles: (q: FakeQuery) => {
        if (h.rolesError) return { data: null, error: { message: "boom" } }
        if (q.op("maybeSingle")) {
          const r = ROLES.find((x) => x.slug === q.filter("slug"))
          return { data: r ? { name: r.name } : null, error: null }
        }
        return { data: ROLES, error: null }
      },
      role_package_prices: (q: FakeQuery) => {
        const roleIds = q.filter("role_id") as string[]
        const pkgIds = q.filter("package_id") as string[]
        return { data: h.rolePrices.filter((r) => roleIds.includes(r.role_id) && pkgIds.includes(r.package_id)), error: null }
      },
      admin_audit_log: (q: FakeQuery) => {
        if (q.kind === "insert") { for (const r of q.payload as any[]) h.audit.push({ ...r, created_at: ++h.clock }); return { data: null, error: null } }
        const rows = h.audit.filter((a) => a.target_user_id === q.filter("target_user_id") && a.action === q.filter("action"))
          .sort((a, b) => b.created_at - a.created_at)
        return { data: rows[0] ? { new_value: rows[0].new_value } : null, error: null }
      },
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
    expect(h.audit).toHaveLength(0)
  })

  it("400s on a missing or unknown role", async () => {
    expect((await POST({ userId: USER_ID })).status).toBe(400)
    expect((await POST({ userId: USER_ID, role: "root" })).status).toBe(400)
  })

  it("refuses dealer for a sub-agent", async () => {
    h.shop = { id: "shop-1", parent_shop_id: "parent-shop" }
    expect((await POST({ userId: USER_ID, newRole: "dealer" })).status).toBe(400)
    expect(h.role).toBe("user")
  })

  it("refuses dealer when the shop cannot be read (it might be a sub-agent's)", async () => {
    h.shopError = true
    const res = await POST({ userId: USER_ID, newRole: "dealer" })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/couldn't verify/i)
    expect(h.role).toBe("user")
    expect(h.fake.ofTable("users").filter((q) => q.kind === "update")).toHaveLength(0)
  })

  it("upgrades to dealer: conditional role update, margins raised by role - dealer price (not for a 0 dealer price), recorded in the audit row", async () => {
    const res = await POST({ userId: USER_ID, newRole: "dealer" })
    expect(await res.json()).toMatchObject({ success: true, newRole: "dealer", changed: true })
    const upd = h.fake.ofTable("users").find((q) => q.kind === "update")!
    expect(upd.op("or")).toEqual(["or", "role.is.null,role.neq.dealer"])
    expect(upd.op("eq")).toEqual(["eq", "id", USER_ID])
    expect(h.margins).toEqual({ sp1: 3, sp2: 1.5, sp3: 1 })
    expect(h.meta).toEqual([{ id: USER_ID, attrs: { user_metadata: { role: "dealer" } } }])
    expect(h.audit).toEqual([expect.objectContaining({
      admin_id: ADMIN_ID, action: "user_role_change", target_user_id: USER_ID, old_value: { role: "user" },
      new_value: { role: "dealer", margin_adjustments: [{ shop_package_id: "sp1", delta: 2 }, { shop_package_id: "sp2", delta: 0.5 }] },
    })])
  })

  it("changeUserRole writes opts.reason into new_value.reason, and only when given", async () => {
    const r1 = await changeUserRole(h.fake.db as any, { userId: USER_ID, role: "dealer", adminId: ADMIN_ID, reason: "promo" })
    expect(r1).toMatchObject({ ok: true, changed: true })
    expect(h.audit[0].new_value).toMatchObject({ role: "dealer", reason: "promo" })
    h.audit = []
    h.role = "user"
    await changeUserRole(h.fake.db as any, { userId: USER_ID, role: "dealer", adminId: ADMIN_ID })
    expect(h.audit[0].new_value).not.toHaveProperty("reason")
  })

  it("protectAdmin: an admin is refused with 403 and nothing is written", async () => {
    h.role = "admin"
    const r = await changeUserRole(h.fake.db as any, { userId: USER_ID, role: "dealer", adminId: ADMIN_ID, protectAdmin: true })
    expect(r).toEqual({ ok: false, status: 403, error: "Admin accounts can't be moved here." })
    expect(h.role).toBe("admin")
    expect(h.fake.ofTable("users").filter((q) => q.kind === "update")).toHaveLength(0)
    expect(h.audit).toHaveLength(0)
  })

  it("protectAdmin: user promoted to admin between read and write -> conditional update matches 0 rows -> 403", async () => {
    h.raceTo = "admin"
    const r = await changeUserRole(h.fake.db as any, { userId: USER_ID, role: "dealer", adminId: ADMIN_ID, protectAdmin: true })
    expect(r).toEqual({ ok: false, status: 403, error: "Admin accounts can't be moved here." })
    expect(h.role).toBe("admin")
    expect(h.audit).toHaveLength(0)
    expect(h.fake.ofTable("users").find((q) => q.kind === "update")!.op("or")).toEqual(["or", "role.is.null,role.not.in.(admin,dealer)"])
  })

  it("protectAdmin: a NULL-role user (counts as user) is actually updated, not silently skipped", async () => {
    h.role = null
    const r = await changeUserRole(h.fake.db as any, { userId: USER_ID, role: "dealer", adminId: ADMIN_ID, protectAdmin: true })
    expect(r).toMatchObject({ ok: true, changed: true, oldRole: "user", newRole: "dealer" })
    expect(h.role).toBe("dealer")
  })

  it("protectAdmin: the row vanishes between read and write -> 404 User not found", async () => {
    h.raceTo = "__gone__"
    const r = await changeUserRole(h.fake.db as any, { userId: USER_ID, role: "dealer", adminId: ADMIN_ID, protectAdmin: true })
    expect(r).toEqual({ ok: false, status: 404, error: "User not found" })
    expect(h.audit).toHaveLength(0)
  })

  it("protectAdmin off (default): an admin can still be changed by existing callers", async () => {
    h.role = "admin"
    expect(await changeUserRole(h.fake.db as any, { userId: USER_ID, role: "user", adminId: ADMIN_ID })).toMatchObject({ ok: true, changed: true })
  })

  it("setting the current role again changes nothing (no second margin bump)", async () => {
    h.role = "dealer"
    expect(await (await POST({ userId: USER_ID, role: "dealer" })).json()).toMatchObject({ success: true, changed: false })
    expect(h.fake.ofTable("shop_packages")).toHaveLength(0)
    expect(h.audit).toHaveLength(0)
  })

  it("race: another request made them a dealer after our read; the conditional update changes no row, so no margins move", async () => {
    h.raceTo = "dealer"
    expect(await (await POST({ userId: USER_ID, role: "dealer" })).json()).toMatchObject({ success: true, changed: false })
    expect(h.margins).toEqual({ sp1: 1, sp2: 1, sp3: 1 })
    expect(h.audit).toHaveLength(0)
  })

  it("user -> dealer -> user -> dealer: the downgrade reverses exactly what the upgrade added", async () => {
    await POST({ userId: USER_ID, role: "dealer" })
    expect(h.margins).toEqual({ sp1: 3, sp2: 1.5, sp3: 1 })
    const down = await POST({ userId: USER_ID, role: "user" })
    const downBody = await down.json()
    expect(downBody).toMatchObject({ success: true, changed: true })
    expect(downBody.note).toBeUndefined()
    expect(h.margins).toEqual({ sp1: 1, sp2: 1, sp3: 1 })
    expect(h.audit[1].new_value).toEqual({ role: "user", margin_adjustments: [{ shop_package_id: "sp1", delta: -2 }, { shop_package_id: "sp2", delta: -0.5 }] })
    await POST({ userId: USER_ID, role: "dealer" })
    expect(h.margins).toEqual({ sp1: 3, sp2: 1.5, sp3: 1 })
    expect(h.role).toBe("dealer")
  })

  it("the reversal uses the recorded deltas, not today's prices, and never takes a margin below 0", async () => {
    await POST({ userId: USER_ID, role: "dealer" })
    PACKAGES[0].dealer_price = 6 // prices changed while they were a dealer
    h.margins.sp2 = 0.2 // the dealer lowered a margin below what the upgrade added
    try {
      await POST({ userId: USER_ID, role: "user" })
      expect(h.margins).toEqual({ sp1: 1, sp2: 0, sp3: 1 })
    } finally {
      PACKAGES[0].dealer_price = 8
    }
  })

  it("dealer -> user without a recorded upgrade: allowed, margins left as they are, with a note for the admin", async () => {
    h.role = "dealer"
    const res = await POST({ userId: USER_ID, role: "user" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      success: true, changed: true,
      note: "Margins were not reversed: this dealer was upgraded before margin changes were recorded. Check their shop prices.",
    })
    expect(h.role).toBe("user")
    expect(h.margins).toEqual({ sp1: 1, sp2: 1, sp3: 1 })
    expect(h.audit[0].new_value).toEqual({ role: "user", margins_not_reversed: true })
  })

  it("dealer -> user without a shop needs no margin work", async () => {
    h.role = "dealer"
    h.shop = null
    expect(await (await POST({ userId: USER_ID, role: "user" })).json()).toMatchObject({ success: true, changed: true })
    expect(h.role).toBe("user")
  })

  it("refuses dealer -> user when the shop cannot be read", async () => {
    h.role = "dealer"
    h.shopError = true
    expect((await POST({ userId: USER_ID, role: "user" })).status).toBe(500)
    expect(h.role).toBe("dealer")
  })

  describe("custom role assignment gate (flag off)", () => {
    it("custom target -> 409 before any users / user_shops / roles read or write", async () => {
      h.customEnabled = false
      const res = await POST({ userId: USER_ID, role: "super" })
      expect(res.status).toBe(409)
      expect((await res.json()).error).toBe("Custom roles can't be assigned yet.")
      expect(h.fake.ofTable("users")).toHaveLength(0)
      expect(h.fake.ofTable("user_shops")).toHaveLength(0)
      expect(h.fake.ofTable("roles")).toHaveLength(0)
      expect(h.role).toBe("user")
      expect(h.audit).toHaveLength(0)
    })

    it("system targets are untouched by the gate, and custom -> system still works", async () => {
      h.customEnabled = false
      expect((await POST({ userId: USER_ID, role: "dealer" })).status).toBe(200)
      h.role = "super"
      expect((await POST({ userId: USER_ID, role: "user" })).status).toBe(200)
      expect(h.role).toBe("user")
    })
  })

  describe("custom roles", () => {
    it("user -> super: margins move by the base difference so selling prices stay fixed; recorded as recompute", async () => {
      const res = await POST({ userId: USER_ID, role: "super" })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ success: true, newRole: "super", changed: true })
      expect(h.role).toBe("super")
      // sp1: 1 + 10 - 9.5 = 1.5; sp2: 1 + 5 - 4 = 2; sp3: public 7 on both sides, unchanged
      expect(h.margins).toEqual({ sp1: 1.5, sp2: 2, sp3: 1 })
      expect(h.audit[0].new_value).toEqual({
        role: "super", margin_mode: "recompute",
        margin_adjustments: [{ shop_package_id: "sp1", delta: 0.5 }, { shop_package_id: "sp2", delta: 1 }],
      })
      expect(h.meta).toEqual([{ id: USER_ID, attrs: { user_metadata: { role: "super" } } }])
      expect((vi.mocked(sendPushToUser).mock.calls[0][1] as any).body).toContain("Super Agent")
    })

    it("super -> dealer is a recompute too (custom on the old side)", async () => {
      h.role = "super"
      h.margins = { sp1: 1.5, sp2: 2, sp3: 1 }
      await POST({ userId: USER_ID, role: "dealer" })
      // dealer has no role_package_prices rows here, so its base is the public price: 1.5 + 9.5 - 10 = 1
      expect(h.margins.sp1).toBe(1)
      expect(h.audit[0].new_value.margin_mode).toBe("recompute")
    })

    it("dealer -> user after a recompute entry recomputes instead of using the legacy reversal", async () => {
      h.role = "super"
      await POST({ userId: USER_ID, role: "dealer" })
      expect(h.audit[0].new_value.margin_mode).toBe("recompute")
      await POST({ userId: USER_ID, role: "user" })
      expect(h.audit[1].new_value.margin_mode).toBe("recompute")
      expect(h.role).toBe("user")
    })

    it("unknown role -> 400 Unknown role; archived role -> 400", async () => {
      const a = await POST({ userId: USER_ID, role: "nope" })
      expect(a.status).toBe(400)
      expect((await a.json()).error).toBe("Unknown role")
      expect((await POST({ userId: USER_ID, role: "old_vip" })).status).toBe(400)
      expect(h.role).toBe("user")
    })

    it("a sub-agent's shop cannot move to a custom role", async () => {
      h.shop = { id: "shop-1", parent_shop_id: "parent-shop" }
      expect((await POST({ userId: USER_ID, role: "super" })).status).toBe(400)
      expect(h.role).toBe("user")
    })

    it("roles read error -> 500 and no users write", async () => {
      h.rolesError = true
      const res = await POST({ userId: USER_ID, role: "super" })
      expect(res.status).toBe(500)
      expect((await res.json()).error).toMatch(/Couldn't load roles/)
      expect(h.fake.ofTable("users").filter((q) => q.kind === "update")).toHaveLength(0)
    })

    it("system -> system changes never read roles", async () => {
      await POST({ userId: USER_ID, role: "dealer" })
      expect(h.fake.ofTable("roles")).toHaveLength(0)
    })

    it("clamp: a margin that cannot absorb the new base goes to 0 and the result carries a note", async () => {
      h.rolePrices = [{ role_id: "r-super", package_id: "p1", price: 11.5 }, { role_id: "r-super", package_id: "p2", price: 4 }]
      const body = await (await POST({ userId: USER_ID, role: "super" })).json()
      expect(body.note).toBe("1 shop packages hit a 0 margin; their selling price rose. Check the shop's prices.")
      expect(h.margins.sp1).toBe(0)
    })

    it("a packages read failure refuses the change before the role write", async () => {
      h.packagesError = true
      const res = await POST({ userId: USER_ID, role: "super" })
      expect(res.status).toBe(500)
      expect(h.fake.ofTable("users").filter((q) => q.kind === "update")).toHaveLength(0)
    })
  })
})
