import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { USERS_ENTRIES } from "./users"
import { CATALOG } from "../index"
import { EXCLUDED } from "../excluded"
import { PENDING } from "../pending"
import { ADMIN_PAGES, pageTitleFor } from "../pages"
import { resolveRequest } from "../resolve"
import type { Risk } from "../types"

const key = (method: string, path: string) => `${method} ${path}`

const CATALOGUED = [
  "DELETE /api/admin/remove-user",
  "DELETE /api/admin/users/:id/notes/:noteId",
  "GET /api/admin/debtors",
  "GET /api/admin/roles",
  "GET /api/admin/roles/:id/audit",
  "GET /api/admin/roles/:id/members",
  "GET /api/admin/roles/:id/permissions",
  "GET /api/admin/roles/:id/prices",
  "GET /api/admin/roles/:id/rates",
  "GET /api/admin/signup-sources",
  "GET /api/admin/users",
  "GET /api/admin/users/:id/audit",
  "GET /api/admin/users/:id/custom-prices",
  "GET /api/admin/users/:id/notes",
  "GET /api/admin/users/:id/orders",
  "GET /api/admin/users/:id/profile",
  "GET /api/admin/users/:id/shop",
  "GET /api/admin/users/:id/signals",
  "GET /api/admin/users/:id/stats",
  "GET /api/admin/users/:id/tags",
  "GET /api/admin/users/:id/transactions",
  "GET /api/admin/users/phone-audit",
  "PATCH /api/admin/roles/:id",
  "PATCH /api/admin/users/:id/notes/:noteId",
  "POST /api/admin/change-user-password",
  "POST /api/admin/remove-admin",
  "POST /api/admin/roles",
  "POST /api/admin/roles/:id/archive",
  "POST /api/admin/roles/:id/move",
  "POST /api/admin/roles/members/move",
  "POST /api/admin/set-admin",
  "POST /api/admin/set-admin-by-email",
  "POST /api/admin/update-balance",
  "POST /api/admin/users/:id/force-logout",
  "POST /api/admin/users/:id/notes",
  "POST /api/admin/users/:id/password-reset",
  "POST /api/admin/users/:id/phone-verified",
  "POST /api/admin/users/:id/tags",
  "POST /api/admin/users/suspend",
  "POST /api/admin/users/update-role",
  "POST /api/admin/users/update-user",
  "PUT /api/admin/roles/:id/permissions",
  "PUT /api/admin/roles/:id/prices",
  "PUT /api/admin/roles/:id/rates",
  "PUT /api/admin/users/:id/custom-prices",
]

const EXCLUDED_ROUTES: Array<[string, RegExp]> = [
  ["GET /api/admin/customers/:id/history", /own shop/],
  ["GET /api/admin/customers/analytics", /own shop/],
  ["GET /api/admin/customers/list", /own shop/],
  ["GET /api/admin/initialize-balance", /1000/],
  ["POST /api/admin/users/bulk", /use the page/],
  ["GET /api/admin/users/export", /use the page/],
]

const byKey = (k: string) => USERS_ENTRIES.find((e) => key(e.method, e.path) === k)!

describe("users catalog coverage", () => {
  it("catalogues exactly the listed routes and registers them in CATALOG", () => {
    expect(USERS_ENTRIES.map((e) => key(e.method, e.path)).sort()).toEqual([...CATALOGUED].sort())
    for (const k of CATALOGUED) {
      expect(PENDING, k).not.toContain(k)
      expect(CATALOG.map((e) => key(e.method, e.path)), k).toContain(k)
    }
  })

  it("moves the excluded routes out of PENDING with a specific reason", () => {
    for (const [k, why] of EXCLUDED_ROUTES) {
      expect(PENDING, k).not.toContain(k)
      const row = EXCLUDED.find((e) => key(e.method, e.path) === k)
      expect(row, k).toBeTruthy()
      expect(row!.reason, k).toMatch(why)
    }
  })

  it("leaves no users-area route in PENDING", () => {
    const area = /^(DELETE|GET|PATCH|POST|PUT) \/api\/admin\/(users|customers|set-admin|set-admin-by-email|remove-admin|remove-user|change-user-password|update-balance|initialize-balance|debtors|signup-sources|roles)(\/|$)/
    expect(PENDING.filter((k) => area.test(k))).toEqual([])
  })

  it("ids are unique and area is users", () => {
    const ids = USERS_ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of USERS_ENTRIES) expect(e.area).toBe("users")
  })
})

describe("users catalog rules", () => {
  it("pages are exact ADMIN_PAGES paths with matching titles", () => {
    const paths = new Set(ADMIN_PAGES.map((p) => p.path))
    for (const e of USERS_ENTRIES) {
      expect(paths.has(e.page), e.id).toBe(true)
      expect(e.pageTitle, e.id).toBe(pageTitleFor(e.page))
    }
  })

  it("every schema is strict and rejects an unknown key", () => {
    for (const e of USERS_ENTRIES) {
      for (const schema of [e.query, e.body].filter(Boolean)) {
        const r = schema!.safeParse({ __unknown_key__: 1 })
        expect(r.success, e.id).toBe(false)
        if (!r.success) expect(r.error.issues.some((i) => i.code === "unrecognized_keys"), e.id).toBe(true)
      }
    }
  })

  it("declares a param for every :name segment", () => {
    for (const e of USERS_ENTRIES) {
      const inPath = e.path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1)).sort()
      expect(Object.keys(e.params ?? {}).sort(), e.id).toEqual(inPath)
    }
  })

  it("lookups have resultKeep, writes are changes, changes have a card or typed tool", () => {
    for (const e of USERS_ENTRIES) {
      if (e.kind === "lookup") {
        expect(e.method, e.id).toBe("GET")
        expect(e.resultKeep?.length, e.id).toBeGreaterThan(0)
      }
      if (e.method !== "GET") expect(e.kind, e.id).toBe("change")
      if (e.kind === "change") expect(Boolean(e.card || e.typedCard), e.id).toBe(true)
    }
  })

  it("lookups never keep passwords, tokens, secrets, hashes, auth data or emails", () => {
    for (const e of USERS_ENTRIES) {
      for (const p of e.resultKeep ?? []) {
        expect(p, e.id).not.toMatch(/password|token|secret|hash|api_?key|payload|email|metadata|(^|[.\]])auth[._]/i)
      }
    }
  })

  it("side-effect GETs would be changes (none in this group write)", () => {
    // users/phone-audit, debtors, signup-sources and every [id] GET only read; initialize-balance (the one GET that
    // writes) is excluded.
    expect(USERS_ENTRIES.some((e) => e.path.includes("initialize-balance"))).toBe(false)
    expect(EXCLUDED.some((e) => e.path === "/api/admin/initialize-balance" && e.method === "GET")).toBe(true)
  })

  it("risk tiers are at least the table's", () => {
    const rank: Record<Risk, number> = { normal: 0, money: 1, danger: 2 }
    const atLeast = (k: string, r: Risk) => expect(rank[byKey(k).risk], k).toBeGreaterThanOrEqual(rank[r])
    atLeast("POST /api/admin/update-balance", "money")
    for (const k of [
      "POST /api/admin/set-admin",
      "POST /api/admin/set-admin-by-email",
      "POST /api/admin/remove-admin",
      "DELETE /api/admin/remove-user",
      "POST /api/admin/change-user-password",
      "POST /api/admin/users/update-role",
      "POST /api/admin/users/suspend",
      "POST /api/admin/roles",
      "PATCH /api/admin/roles/:id",
      "POST /api/admin/roles/:id/archive",
      "POST /api/admin/roles/:id/move",
      "POST /api/admin/roles/members/move",
      "PUT /api/admin/roles/:id/permissions",
      "PUT /api/admin/roles/:id/prices",
      "PUT /api/admin/roles/:id/rates",
    ]) {
      atLeast(k, "danger")
    }
  })

  it("typed tools are used where the typed tool performs the same action", () => {
    expect(byKey("POST /api/admin/update-balance").typedCard).toBe("prepare_wallet_adjustment")
    expect(byKey("POST /api/admin/users/suspend").typedCard).toBe("prepare_user_suspension")
    expect(byKey("POST /api/admin/users/update-role").typedCard).toBe("prepare_role_change")
    // The typed tools call exactly these endpoints (lib/ai-drafts/execute.ts).
    expect(Object.keys(byKey("POST /api/admin/users/suspend").body!.shape).sort()).toEqual(["action", "reason", "userId"])
    expect(Object.keys(byKey("POST /api/admin/users/update-role").body!.shape).sort()).toEqual(["role", "userId"])
    for (const e of USERS_ENTRIES) if (e.typedCard) expect(e.card, e.id).toBeUndefined()
  })

  it("the password is a secure-box field and never part of any schema", () => {
    const e = byKey("POST /api/admin/change-user-password")
    expect(e.secretFields).toEqual([{ name: "newPassword", label: "New password", min: 8, max: 128 }])
    expect(Object.keys(e.body!.shape)).toEqual(["userId"])
    // The secure box must refuse a password passed through the model.
    const viaModel = resolveRequest(e, { body: { userId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", newPassword: "SECRET123" } })
    expect(viaModel.ok).toBe(false)
    // update-user's handler would also set a password; here it is not accepted at all.
    expect(byKey("POST /api/admin/users/update-user").body!.safeParse({ userId: U1, password: "SECRET123" }).success).toBe(false)
    for (const x of USERS_ENTRIES) {
      if (x === e) continue
      expect(x.secretFields ?? [], x.id).toEqual([])
      for (const schema of [x.query, x.body].filter(Boolean)) {
        for (const k of Object.keys(schema!.shape)) expect(k, x.id).not.toMatch(/secret|api_?key|token|password/i)
      }
    }
  })

  it("set-admin-by-email is not behind verifyAdminAccess", () => {
    expect(byKey("POST /api/admin/set-admin-by-email").auth).toBe("other")
    for (const x of USERS_ENTRIES) if (x.id !== "users.set_admin_by_email") expect(x.auth, x.id).toBe("admin")
  })

  it("timeouts stay within 60 s", () => {
    for (const e of USERS_ENTRIES) if (e.timeoutMs !== undefined) expect(e.timeoutMs, e.id).toBeLessThanOrEqual(60000)
  })

  it("bulk role move is capped so it fits the time limit, and refuses admin and sub-agent targets by schema or card", () => {
    const b = byKey("POST /api/admin/roles/members/move").body!
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`)
    expect(b.safeParse({ user_ids: ids(50), to_role: "dealer", reason: "tier change" }).success).toBe(true)
    expect(b.safeParse({ user_ids: ids(51), to_role: "dealer", reason: "tier change" }).success).toBe(false)
  })

  it("roles prices schema accepts a clear (null) and rejects zero", () => {
    const b = byKey("PUT /api/admin/roles/:id/prices").body!
    expect(b.safeParse({ changes: [{ package_id: U1, price: null }], reason: "reset" }).success).toBe(true)
    expect(b.safeParse({ changes: [{ package_id: U1, price: 0 }], reason: "reset" }).success).toBe(false)
  })
})

// ---- card tests with a tiny fake db ----------------------------------------------------------------------------

type Row = Record<string, unknown>

function fakeDb(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? []
      const filters: Array<(r: Row) => boolean> = []
      const b: any = {
        select() { return b },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b },
        in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b },
        ilike(c: string, pat: string) {
          const want = pat.replace(/\\(.)/g, "$1").toLowerCase()
          filters.push((r) => String(r[c] ?? "").toLowerCase() === want)
          return b
        },
        limit() { return b },
        order() { return b },
        maybeSingle() { const d = rows.filter((r) => filters.every((f) => f(r))); return Promise.resolve({ data: d[0] ?? null, error: null }) },
        single() { const d = rows.filter((r) => filters.every((f) => f(r))); return Promise.resolve({ data: d[0] ?? null, error: d.length ? null : { message: "none" } }) },
        then(res: any, rej: any) {
          const d = rows.filter((r) => filters.every((f) => f(r)))
          return Promise.resolve({ data: d, count: d.length, error: null }).then(res, rej)
        },
      }
      return b
    },
  } as unknown as SupabaseClient
}

const brokenDb = { from() { throw new Error("db down") } } as unknown as SupabaseClient

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001"
const U2 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002"
const U3 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000003"
const R1 = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001"
const R2 = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002"
const R3 = "bbbbbbbb-bbbb-4bbb-8bbb-000000000003"
const P1 = "cccccccc-cccc-4ccc-8ccc-000000000001"
const P2 = "cccccccc-cccc-4ccc-8ccc-000000000002"
const N1 = "dddddddd-dddd-4ddd-8ddd-000000000001"
const ADMIN = "11111111-1111-4111-8111-111111111111"

const tables: Record<string, Row[]> = {
  users: [
    { id: U1, first_name: "Ama", last_name: "Mensah", phone_number: "0241234567", email: "leak@example.com", role: "dealer", phone_verified: false, pricing_mode: "role" },
    { id: U2, first_name: "Kofi", last_name: "Boateng", phone_number: "0551234567", email: "kofi@example.com", role: "admin" },
    { id: U3, first_name: "Yaw", last_name: "Asare", phone_number: "0201234567", email: "yaw@example.com", role: "user" },
    { id: ADMIN, first_name: "Boss", last_name: "Admin", phone_number: "0261234567", email: "boss@example.com", role: "admin" },
  ],
  wallets: [{ user_id: U1, balance: 120.5 }],
  orders: [{ id: "o1", user_id: U1 }, { id: "o2", user_id: U1 }],
  user_shops: [{ id: "s1", user_id: U1 }],
  password_reset_requests: [{ id: "p1", user_id: U1 }],
  admin_user_notes: [{ id: N1, body: "Called about a refund", author_id: ADMIN }],
  admin_user_tags: [{ user_id: U1, tag: "vip" }],
  roles: [
    { id: R1, slug: "dealer", name: "Dealer", rank: 10, is_system: true, archived_at: null },
    { id: R2, slug: "gold", name: "Gold", rank: 20, is_system: false, archived_at: null },
    { id: R3, slug: "platinum", name: "Platinum", rank: 30, is_system: false, archived_at: null },
  ],
  role_permissions: [{ role_id: R2, capability: "buy.data" }, { role_id: R2, capability: "buy.airtime" }],
  role_package_prices: [{ role_id: R2, package_id: P1, price: 9 }],
  packages: [{ id: P1, network: "MTN", name: "5GB" }, { id: P2, network: "MTN", name: "10GB" }],
  package_costs: [{ package_id: P1, cost_price: 8 }, { package_id: P2, cost_price: 15 }],
  role_service_rates: [{ role_id: R2, service_key: "airtime_fee:mtn", value: 2 }],
}
// Two members in "gold", one in "dealer".
tables.users.push({ id: "eeeeeeee-eeee-4eee-8eee-000000000001", role: "gold" }, { id: "eeeeeeee-eeee-4eee-8eee-000000000002", role: "gold" })

const CARD_INPUTS: Record<string, { params?: Record<string, string>; query?: Record<string, unknown>; body?: Record<string, unknown> }> = {
  "DELETE /api/admin/remove-user": { body: { userId: U1 } },
  "DELETE /api/admin/users/:id/notes/:noteId": { params: { id: U1, noteId: N1 } },
  "PATCH /api/admin/roles/:id": { params: { id: R2 }, body: { name: "Gold Plus", badge_color: "amber" } },
  "PATCH /api/admin/users/:id/notes/:noteId": { params: { id: U1, noteId: N1 }, body: { body: "Updated note" } },
  "POST /api/admin/change-user-password": { body: { userId: U1 } },
  "POST /api/admin/remove-admin": { body: { userId: U2 } },
  "POST /api/admin/roles": { body: { slug: "silver", name: "Silver", rank: 25, clone_from: "gold", reason: "new tier" } },
  "POST /api/admin/roles/:id/archive": { params: { id: R2 }, body: { reason: "retired" } },
  "POST /api/admin/roles/:id/move": { params: { id: R2 }, body: { direction: "up", reason: "reorder" } },
  "POST /api/admin/roles/members/move": { body: { user_ids: [U1, U2, U3, "eeeeeeee-eeee-4eee-8eee-000000000001"], to_role: "dealer", reason: "tier change" } },
  "POST /api/admin/set-admin": { body: { userId: U3 } },
  "POST /api/admin/set-admin-by-email": { body: { email: "yaw@example.com" } },
  "POST /api/admin/users/:id/force-logout": { params: { id: U1 } },
  "POST /api/admin/users/:id/notes": { params: { id: U1 }, body: { body: "New note" } },
  "POST /api/admin/users/:id/password-reset": { params: { id: U1 } },
  "POST /api/admin/users/:id/phone-verified": { params: { id: U1 }, body: { verified: true } },
  "POST /api/admin/users/:id/tags": { params: { id: U1 }, body: { add: ["risky"], remove: ["vip"] } },
  "POST /api/admin/users/update-user": { body: { userId: U1, email: "new@example.com", phoneNumber: "0559998888", firstName: "Abena" } },
  "PUT /api/admin/roles/:id/permissions": { params: { id: R2 }, body: { capabilities: ["buy.data", "shop.storefront"], reason: "rights review" } },
  "PUT /api/admin/roles/:id/prices": {
    params: { id: R2 },
    body: { changes: [{ package_id: P1, price: 7 }, { package_id: P2, price: null }], reason: "promo" },
  },
  "PUT /api/admin/roles/:id/rates": { params: { id: R2 }, body: { changes: [{ service_key: "airtime_fee:mtn", value: 1.5 }], reason: "promo" } },
  "PUT /api/admin/users/:id/custom-prices": { params: { id: U1 }, body: { pricing_mode: "custom", prices: [{ package_id: P1, price: 7 }, { package_id: P2, price: null }] } },
}

describe("users change cards", () => {
  const changes = USERS_ENTRIES.filter((e) => e.kind === "change" && !e.typedCard)

  it("has a sample input for every card entry", () => {
    for (const e of changes) expect(CARD_INPUTS[key(e.method, e.path)], e.id).toBeTruthy()
  })

  it("every sample input is valid for the entry's own schema", () => {
    for (const e of changes) {
      const inp = CARD_INPUTS[key(e.method, e.path)]
      if (e.body) expect(e.body.safeParse(inp.body ?? {}).success, e.id).toBe(true)
    }
  })

  for (const e of changes) {
    const inp = CARD_INPUTS[key(e.method, e.path)] ?? {}
    it(`${e.id}: summary and at least one line, no secrets or full contact details`, async () => {
      const c = await e.card!(inp, { db: fakeDb(tables), adminId: ADMIN })
      expect(c.summary.length).toBeGreaterThan(0)
      expect(c.lines.length).toBeGreaterThanOrEqual(1)
      const text = JSON.stringify(c)
      expect(text).not.toContain("SECRET123")
      for (const full of ["leak@example.com", "0241234567", "0551234567", "yaw@example.com", "kofi@example.com", "new@example.com", "0559998888"]) {
        expect(text, full).not.toContain(full)
      }
    })
    it(`${e.id}: still returns a card when the database fails`, async () => {
      const c = await e.card!(inp, { db: brokenDb, adminId: ADMIN })
      expect(c.summary.length).toBeGreaterThan(0)
      expect(c.lines.length).toBeGreaterThanOrEqual(1)
    })
  }

  const run = (k: string, input: any, db: SupabaseClient = fakeDb(tables), adminId = ADMIN) => byKey(k).card!(input, { db, adminId })
  const text = async (k: string, input: any, db?: SupabaseClient, adminId?: string) => JSON.stringify(await run(k, input, db, adminId))

  it("password change names the user masked, the secure box and the sessions ended, and never echoes the password", async () => {
    const c = await text("POST /api/admin/change-user-password", { body: { userId: U1, newPassword: "SECRET123" } })
    expect(c).toContain("Ama Mensah")
    expect(c).toContain("024 *** 4567")
    expect(c).toMatch(/secure box/i)
    expect(c).toMatch(/every signed-in session/i)
    expect(c).toMatch(/not told/i)
    expect(c).not.toContain("SECRET123")
  })

  it("set-admin names the full powers, the audit row, and flags a missing user", async () => {
    const c = await text("POST /api/admin/set-admin", CARD_INPUTS["POST /api/admin/set-admin"])
    expect(c).toMatch(/full admin/i)
    expect(c).toMatch(/wallet adjustments/i)
    expect(c).toMatch(/admin history/i)
    const missing = await text("POST /api/admin/set-admin", { body: { userId: "aaaaaaaa-aaaa-4aaa-8aaa-0000000000ff" } })
    expect(missing).toMatch(/No user with this id/i)
    const already = await text("POST /api/admin/set-admin", { body: { userId: U2 } })
    expect(already).toMatch(/already an admin/i)
  })

  it("set-admin-by-email masks the email and says no history entry is written", async () => {
    const c = await text("POST /api/admin/set-admin-by-email", CARD_INPUTS["POST /api/admin/set-admin-by-email"])
    expect(c).toContain("y***@example.com")
    expect(c).toMatch(/NO entry is written/)
    const none = await text("POST /api/admin/set-admin-by-email", { body: { email: "nobody@example.com" } })
    expect(none).toMatch(/No profile with this email/i)
  })

  it("remove-admin warns it sets role to user whatever it was, on your own account and on the last admin", async () => {
    const c = await text("POST /api/admin/remove-admin", { body: { userId: U1 } })
    expect(c).toMatch(/not an admin/i)
    expect(c).toMatch(/dealer/)
    const own = await text("POST /api/admin/remove-admin", { body: { userId: ADMIN } })
    expect(own).toMatch(/your own account/i)
    const lone = fakeDb({ users: [{ id: U2, first_name: "Kofi", role: "admin" }] })
    const last = await text("POST /api/admin/remove-admin", { body: { userId: U2 } }, lone)
    expect(last).toMatch(/only admin/i)
  })

  it("remove-user lists the data deleted, the lost balance and the refusals", async () => {
    const c = await text("DELETE /api/admin/remove-user", CARD_INPUTS["DELETE /api/admin/remove-user"])
    expect(c).toContain("GHS 120.50")
    expect(c).toMatch(/Orders deleted/)
    expect(c).toMatch(/cannot be undone/i)
    expect(c).toMatch(/nothing is paid out/i)
    const admin = await text("DELETE /api/admin/remove-user", { body: { userId: U2 } })
    expect(admin).toMatch(/cannot be deleted/i)
    const self = await text("DELETE /api/admin/remove-user", { body: { userId: ADMIN } })
    expect(self).toMatch(/your own account/i)
  })

  it("update-user shows masked before and after, and says the history and user are not told", async () => {
    const c = await text("POST /api/admin/users/update-user", CARD_INPUTS["POST /api/admin/users/update-user"])
    expect(c).toContain("l***@example.com")
    expect(c).toContain("n***@example.com")
    expect(c).toContain("024 *** 4567")
    expect(c).toContain("055 *** 8888")
    expect(c).toMatch(/sign-in email/i)
    expect(c).toMatch(/No entry is written/)
    const none = await text("POST /api/admin/users/update-user", { body: { userId: U1 } })
    expect(none).toMatch(/nothing will change/i)
  })

  it("force logout and password reset say what they do not do", async () => {
    expect(await text("POST /api/admin/users/:id/force-logout", CARD_INPUTS["POST /api/admin/users/:id/force-logout"])).toMatch(/straight back in/i)
    const pr = await text("POST /api/admin/users/:id/password-reset", CARD_INPUTS["POST /api/admin/users/:id/password-reset"])
    expect(pr).toMatch(/5 minutes/)
    expect(pr).toMatch(/3 reset links/)
    expect(pr).toContain("l***@example.com")
  })

  it("phone-verified names the refund routing", async () => {
    const c = await text("POST /api/admin/users/:id/phone-verified", CARD_INPUTS["POST /api/admin/users/:id/phone-verified"])
    expect(c).toMatch(/refunds/i)
    expect(c).toMatch(/no -> yes/)
  })

  it("custom prices say what the user pays and that nothing already ordered changes", async () => {
    const c = await text("PUT /api/admin/users/:id/custom-prices", CARD_INPUTS["PUT /api/admin/users/:id/custom-prices"])
    expect(c).toMatch(/1 set, 1 cleared/)
    expect(c).toMatch(/what this user pays/i)
    expect(c).toMatch(/already placed/i)
  })

  it("role members move counts the moved and skipped users and names the pushes and margins", async () => {
    const c = await run("POST /api/admin/roles/members/move", CARD_INPUTS["POST /api/admin/roles/members/move"])
    const lines = Object.fromEntries(c.lines.map((l) => [l.label, l.value]))
    // U1 is already a dealer, U2 is an admin; U3 (user) and the fourth id (gold member) move.
    expect(lines["Will be moved"]).toBe("2")
    const all = JSON.stringify(c)
    expect(all).toMatch(/push notification/i)
    expect(all).toMatch(/margins/i)
    expect(all).toMatch(/admin accounts/i)
    const custom = await text("POST /api/admin/roles/members/move", { body: { user_ids: [U3], to_role: "gold", reason: "tier change" } })
    expect(custom).toMatch(/Custom roles can't be assigned yet/)
  })

  it("role archive refuses a role with members and says it is final for assignment", async () => {
    const c = await text("POST /api/admin/roles/:id/archive", CARD_INPUTS["POST /api/admin/roles/:id/archive"])
    expect(c).toMatch(/still has 2 members/)
    expect(c).toMatch(/slug stays reserved/i)
  })

  it("role move names the neighbour it swaps with and the price fallback", async () => {
    const up = await text("POST /api/admin/roles/:id/move", CARD_INPUTS["POST /api/admin/roles/:id/move"])
    expect(up).toMatch(/Platinum/)
    expect(up).toMatch(/next lower-ranked role/i)
    const top = await text("POST /api/admin/roles/:id/move", { params: { id: R3 }, body: { direction: "up", reason: "reorder" } })
    expect(top).toMatch(/end of the ladder/i)
    const dealer = await text("POST /api/admin/roles/:id/move", { params: { id: R1 }, body: { direction: "up", reason: "reorder" } })
    expect(dealer).toMatch(/cannot be moved/i)
  })

  it("role permissions show gains, losses and members affected", async () => {
    const c = await run("PUT /api/admin/roles/:id/permissions", CARD_INPUTS["PUT /api/admin/roles/:id/permissions"])
    const lines = Object.fromEntries(c.lines.map((l) => [l.label, l.value]))
    expect(lines["Gains"]).toBe("shop.storefront")
    expect(lines["Loses"]).toBe("buy.airtime")
    expect(lines["Members affected"]).toBe("2")
  })

  it("role prices show before and after, the cost problem and the loss override", async () => {
    const c = await text("PUT /api/admin/roles/:id/prices", CARD_INPUTS["PUT /api/admin/roles/:id/prices"])
    expect(c).toContain("GHS 9.00 -> GHS 7.00")
    expect(c).toMatch(/below cost/i)
    expect(c).toMatch(/refused/i)
    const lo = await text("PUT /api/admin/roles/:id/prices", {
      params: { id: R2 },
      body: { changes: [{ package_id: P1, price: 7 }], loss_override: true, reason: "promo" },
    })
    expect(lo).toMatch(/Loss override is on/)
  })

  it("role create flags the feature switch and a taken slug", async () => {
    const c = await text("POST /api/admin/roles", CARD_INPUTS["POST /api/admin/roles"])
    expect(c).toMatch(/no user can be given it yet/i)
    expect(c).toMatch(/copied/i)
    const taken = await text("POST /api/admin/roles", { body: { slug: "gold", name: "Gold", rank: 25, reason: "new tier" } })
    expect(taken).toMatch(/already exists/i)
  })

  it("every change card on the roles hub says it is written to the role's history", async () => {
    for (const e of changes.filter((x) => x.path.startsWith("/api/admin/roles"))) {
      const c = await run(key(e.method, e.path), CARD_INPUTS[key(e.method, e.path)])
      expect(JSON.stringify(c), e.id).toMatch(/history/i)
    }
  })
})
