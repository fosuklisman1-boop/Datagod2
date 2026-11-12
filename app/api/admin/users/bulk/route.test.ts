import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { ADMIN_ID, createFakeDb, type FakeDb, type FakeQuery, type GateMode } from "@/lib/admin-users/test-fake-db"

const h = vi.hoisted(() => ({
  gate: "admin" as GateMode,
  fake: null as unknown as FakeDb,
  authUpdates: [] as Array<{ id: string; attrs: any }>,
  enqueued: [] as any[],
  drained: [] as any[],
  users: {} as Record<string, { role: string; is_suspended: boolean; email: string; phone_number: string | null; first_name: string }>,
  shops: {} as Record<string, { id: string; parent_shop_id: string | null }>,
  exportPages: [] as any[],
  /** Work the route handed to runAfterResponse (sent after the response). */
  afterTasks: [] as Array<() => Promise<void>>,
  sms: [] as string[],
  broadcastFails: false,
  notificationsFail: false,
  auditFailBatches: 0,
}))
vi.mock("@/lib/admin-users/after-response", () => ({ runAfterResponse: (t: () => Promise<void>) => { h.afterTasks.push(t) } }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => (await import("@/lib/admin-users/test-fake-db")).fakeVerify(h.gate)),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async () => ({ sent: 1, removed: 0 })) }))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: vi.fn(async (o: { phone: string }) => { h.sms.push(o.phone); return { success: true } }),
  SMSTemplates: { userSuspended: () => "s", userUnsuspended: () => "u" },
}))
vi.mock("@/lib/email-service", () => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  EmailTemplates: { userSuspended: () => ({ subject: "s", html: "h" }), userUnsuspended: () => ({ subject: "u", html: "h" }) },
}))
vi.mock("@/lib/broadcast-drain", () => ({
  enqueueRecipients: vi.fn(async (_db: unknown, broadcastId: string, opts: any) => {
    h.enqueued.push({ broadcastId, ...opts })
    return opts.specificUsers?.length ?? 0
  }),
  drainBroadcasts: vi.fn(async (_db: unknown, opts: any) => { h.drained.push(opts) }),
}))

import { POST as RAW_POST } from "./route"

const POST = async (body: unknown) =>
  (await RAW_POST(new NextRequest("http://x/api/admin/users/bulk", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })))!

const U = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`
const audits = () => h.fake.ofTable("admin_audit_log").flatMap((q) => q.payload as any[])

function usersHandler(q: FakeQuery) {
  const id = q.filter("id") as string | string[]
  if (q.kind === "update") {
    const u = h.users[id as string]
    // the role write is conditional: or=(role.is.null,role.neq.<new role>)
    const neq = /role\.neq\.(\w+)/.exec(String(q.op("or")?.[1] ?? ""))?.[1]
    if (!u || (neq && u.role === neq)) return { data: [], error: null }
    Object.assign(u, q.payload)
    return { data: [{ id }], error: null }
  }
  if (Array.isArray(id)) {
    return { data: id.filter((x) => h.users[x]).map((x) => ({ id: x, ...h.users[x] })), error: null }
  }
  const u = h.users[id]
  if (u) return { data: { ...u }, error: null }
  // as PostgREST: maybeSingle() answers no row with null, single() with an error
  return q.op("maybeSingle") ? { data: null, error: null } : { data: null, error: { message: "not found", code: "PGRST116" } }
}

beforeEach(() => {
  h.gate = "admin"
  h.authUpdates = []
  h.enqueued = []
  h.drained = []
  h.exportPages = []
  h.afterTasks = []
  h.sms = []
  h.broadcastFails = false
  h.notificationsFail = false
  h.auditFailBatches = 0
  h.users = {
    [U(1)]: { role: "user", is_suspended: false, email: "one@x.com", phone_number: "0244000001", first_name: "One" },
    [U(2)]: { role: "dealer", is_suspended: true, email: "two@x.com", phone_number: null, first_name: "Two" },
    [U(3)]: { role: "user", is_suspended: false, email: "three@x.com", phone_number: "0244000003", first_name: "Three" },
    [ADMIN_ID]: { role: "admin", is_suspended: false, email: "boss@x.com", phone_number: null, first_name: "Boss" },
  }
  h.shops = { [U(3)]: { id: "shop-3", parent_shop_id: "parent-shop" } }
  h.fake = createFakeDb({
    tables: {
      users: usersHandler,
      user_shops: (q) => ({ data: h.shops[q.filter("user_id") as string] ?? null, error: null }),
      shop_packages: () => ({ data: [], error: null }),
      admin_audit_log: () => (h.auditFailBatches-- > 0 ? { data: null, error: { message: "audit down" } } : { data: null, error: null }),
      notifications: () => (h.notificationsFail ? { data: null, error: { message: "down" } } : { data: null, error: null }),
      broadcast_logs: (q) => (q.kind === "insert"
        ? (h.broadcastFails ? { data: null, error: { message: "broadcast_logs down" } } : { data: { id: "bc-1" }, error: null })
        : { data: null, error: null }),
    },
    rpc: (name) => {
      if (name === "admin_export_users") return h.exportPages.shift() ?? { data: { rows: [], next_cursor: null }, error: null }
      if (name === "recompute_broadcast_results") return { data: null, error: null }
      return { data: null, error: { message: `unexpected rpc ${name}` } }
    },
  })
  ;(h.fake.db.auth.admin as any).updateUserById = async (id: string, attrs: unknown) => { h.authUpdates.push({ id, attrs }); return { error: null } }
})

describe("POST /api/admin/users/bulk: gate and validation", () => {
  it("honours 403 and 429, and refuses the CRON bypass (writes need an admin to audit under)", async () => {
    const body = { action: "unsuspend", userIds: [U(2)] }
    h.gate = "forbidden"
    expect((await POST(body)).status).toBe(403)
    h.gate = "rate_limited"
    expect((await POST(body)).status).toBe(429)
    h.gate = "cron"
    const res = await POST(body)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("Admin session required")
    expect(h.fake.queries).toHaveLength(0)
    expect(h.authUpdates).toHaveLength(0)
  })

  it("400s on bad JSON, a bad action, bad ids or missing params, without touching the database", async () => {
    expect((await POST("{nope")).status).toBe(400)
    expect((await POST({ action: "delete", userIds: [U(1)] })).status).toBe(400)
    expect((await POST({ action: "suspend", userIds: ["x"], params: { reason: "abc" } })).status).toBe(400)
    expect((await POST({ action: "suspend", userIds: [U(1)], params: {} })).status).toBe(400)
    const res = await POST({ action: "set_role", userIds: [U(1)], params: { role: "sub_agent" } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Invalid request", details: ["params.role must be one of: user, dealer, admin"] })
    expect(h.fake.queries).toHaveLength(0)
  })

  it("caps explicit selections at 200 users", async () => {
    const ok = await POST({ action: "unsuspend", userIds: Array.from({ length: 200 }, (_, i) => U(1000 + i)) })
    expect(ok.status).toBe(200)
    expect((await ok.json()).total).toBe(200)
    const res = await POST({ action: "unsuspend", userIds: Array.from({ length: 201 }, (_, i) => U(1000 + i)) })
    expect(res.status).toBe(400)
    expect((await res.json()).details).toEqual(["At most 200 users per bulk action"])
  })

  it("refuses 'every matching user' for role and suspension changes", async () => {
    const res = await POST({ action: "suspend", matching: { role: "dealer" }, params: { reason: "fraud ring" } })
    expect(res.status).toBe(400)
    expect(h.fake.queries).toHaveLength(0)
  })
})

describe("POST /api/admin/users/bulk: set_role", () => {
  it("dealer -> user without a recorded upgrade is done, with the margins note in the result", async () => {
    h.shops[U(2)] = { id: "shop-2", parent_shop_id: null }
    h.fake = createFakeDb({
      tables: {
        users: usersHandler,
        user_shops: (q) => ({ data: h.shops[q.filter("user_id") as string] ?? null, error: null }),
        shop_packages: () => ({ data: [{ id: "sp1", package_id: "p1", profit_margin: 1 }], error: null }),
        packages: () => ({ data: [{ id: "p1", price: 10, dealer_price: 8 }], error: null }),
        admin_audit_log: () => ({ data: null, error: null }),
      },
    })
    ;(h.fake.db.auth.admin as any).updateUserById = async () => ({ error: null })
    const body = await (await POST({ action: "set_role", userIds: [U(2)], params: { role: "user" } })).json()
    expect(body.results).toEqual([{ id: U(2), ok: true,
      note: "Margins were not reversed: this dealer was upgraded before margin changes were recorded. Check their shop prices." }])
    expect(h.users[U(2)].role).toBe("user")
  })

  it("applies the update-role rules per user, skips the acting admin, and audits each change", async () => {
    const res = await POST({ action: "set_role", userIds: [U(1), U(2), U(3), ADMIN_ID, U(9)], params: { role: "dealer" } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ action: "set_role", total: 5, succeeded: 2, failed: 3 })
    expect(body.results).toEqual([
      { id: U(1), ok: true },
      { id: U(2), ok: true, note: "unchanged" },
      { id: U(3), ok: false, error: expect.stringMatching(/^Sub-agents cannot be upgraded to Dealers/) },
      { id: ADMIN_ID, ok: false, error: "You cannot change your own role" },
      { id: U(9), ok: false, error: "User not found" },
    ])
    expect(h.users[U(1)].role).toBe("dealer")
    expect(h.users[U(3)].role).toBe("user")
    expect(h.users[ADMIN_ID].role).toBe("admin")
    expect(h.authUpdates).toEqual([{ id: U(1), attrs: { user_metadata: { role: "dealer" } } }])
    // one audit row, for the one user changed
    expect(audits()).toEqual([{
      admin_id: ADMIN_ID, action: "user_role_change", target_user_id: U(1), old_value: { role: "user" },
      new_value: { role: "dealer", margin_adjustments: [] },
    }])
  })
})

describe("POST /api/admin/users/bulk: suspend / unsuspend", () => {
  it("suspends each user with the reason, skips self and already-suspended users, one audit row per change", async () => {
    const res = await POST({ action: "suspend", userIds: [U(1), U(2), ADMIN_ID, U(3)], params: { reason: "  chargebacks  " } })
    const body = await res.json()
    expect(body).toMatchObject({ total: 4, succeeded: 3, failed: 1 })
    expect(body.results).toEqual([
      { id: U(1), ok: true },
      { id: U(2), ok: true, note: "unchanged" },
      { id: ADMIN_ID, ok: false, error: "You cannot suspend or unsuspend yourself" },
      { id: U(3), ok: true },
    ])
    expect(h.authUpdates.map((u) => u.id).sort()).toEqual([U(1), U(3)].sort())
    // the users' SMS / email / push go out after the response, not inside the 300s request
    expect(h.sms).toEqual([])
    expect(h.afterTasks).toHaveLength(1)
    await h.afterTasks[0]()
    expect(h.sms.sort()).toEqual(["0244000001", "0244000003"])
    expect(h.authUpdates[0].attrs).toEqual({ ban_duration: "876000h" })
    expect(h.users[U(1)].is_suspended).toBe(true)
    expect(h.users[ADMIN_ID].is_suspended).toBe(false)
    expect(audits().sort((a, b) => a.target_user_id.localeCompare(b.target_user_id))).toEqual([U(1), U(3)].sort().map((id) => ({
      admin_id: ADMIN_ID, action: "user_suspend", target_user_id: id,
      old_value: { is_suspended: false }, new_value: { is_suspended: true, reason: "chargebacks" },
    })))
  })

  it("unsuspends, reporting failures per user", async () => {
    ;(h.fake.db.auth.admin as any).updateUserById = async (id: string) => (id === U(2) ? { error: { message: "auth down" } } : { error: null })
    h.users[U(1)].is_suspended = true
    const body = await (await POST({ action: "unsuspend", userIds: [U(1), U(2)] })).json()
    expect(body.results).toEqual([
      { id: U(1), ok: true },
      { id: U(2), ok: false, error: "Supabase Auth update failed: auth down" },
    ])
    expect(audits().map((a) => [a.target_user_id, a.action])).toEqual([[U(1), "user_unsuspend"]])
  })
})

describe("POST /api/admin/users/bulk: notify", () => {
  const params = { title: "Maintenance", message: "Back at 6pm", channels: ["in_app", "push", "sms"] }

  it("in-app rows + one broadcast for push/SMS through the Broadcast path, per-user results, an audit row per user", async () => {
    const res = await POST({ action: "notify", userIds: [U(1), U(2), U(9)], params })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ action: "notify", total: 3, succeeded: 2, failed: 1, broadcastId: "bc-1" })
    expect(body.results).toEqual([
      { id: U(1), ok: true, channels: { in_app: "sent", push: "queued", sms: "queued" } },
      { id: U(2), ok: true, note: "No phone number: SMS skipped", channels: { in_app: "sent", push: "queued", sms: "queued" } },
      { id: U(9), ok: false, error: "User not found" },
    ])
    expect(h.fake.ofTable("notifications")[0].payload).toEqual([U(1), U(2)].map((id) => ({
      user_id: id, title: "Maintenance", message: "Back at 6pm", type: "admin_action", action_url: "/dashboard", read: false,
    })))
    const log = h.fake.ofTable("broadcast_logs").find((q) => q.kind === "insert")!.payload as any
    expect(log).toMatchObject({ admin_id: ADMIN_ID, channels: ["push", "sms"], target_type: "specific", subject: "Maintenance", message: "Back at 6pm" })
    expect(h.enqueued).toEqual([{ broadcastId: "bc-1", targetType: "specific", specificUsers: [
      { id: U(1), email: "one@x.com", phone: "0244000001", name: "One" },
      { id: U(2), email: "two@x.com", phone: undefined, name: "Two" },
    ] }])
    expect(h.drained).toEqual([{ broadcastId: "bc-1", maxRecipients: 30 }])
    expect(audits().map((a) => [a.target_user_id, a.action, a.new_value])).toEqual([U(1), U(2)].map((id) => [
      id, "user_notify", { title: "Maintenance", channels: ["in_app", "push", "sms"], broadcast_id: "bc-1" },
    ]))
  })

  it("in-app only does not start a broadcast", async () => {
    const body = await (await POST({ action: "notify", userIds: [U(1)], params: { ...params, channels: ["in_app"] } })).json()
    expect(body).toMatchObject({ succeeded: 1, broadcastId: null })
    expect(h.fake.ofTable("broadcast_logs")).toHaveLength(0)
  })

  it("in-app saved but push/SMS not queued: ok, with a note; the audit row lists only in_app", async () => {
    h.broadcastFails = true
    const body = await (await POST({ action: "notify", userIds: [U(1)], params })).json()
    expect(body.results).toEqual([{ id: U(1), ok: true, note: "Push/SMS not queued (Push / SMS could not be queued)", channels: { in_app: "sent", push: "failed", sms: "failed" } }])
    expect(body.broadcastId).toBeNull()
    expect(audits().map((a) => a.new_value.channels)).toEqual([["in_app"]])
  })

  it("in-app failed but push/SMS queued: ok, says the in-app part failed; the audit row lists push and sms", async () => {
    h.notificationsFail = true
    const body = await (await POST({ action: "notify", userIds: [U(1)], params })).json()
    expect(body.results).toEqual([{ id: U(1), ok: true, note: "In-app notification not saved", channels: { in_app: "failed", push: "queued", sms: "queued" } }])
    expect(audits().map((a) => a.new_value.channels)).toEqual([["push", "sms"]])
  })

  it("every channel failed: not ok, and no audit row", async () => {
    h.notificationsFail = true
    h.broadcastFails = true
    const body = await (await POST({ action: "notify", userIds: [U(1)], params })).json()
    expect(body.results).toEqual([{ id: U(1), ok: false, error: "In-app notification not saved; push/SMS not queued (Push / SMS could not be queued)", channels: { in_app: "failed", push: "failed", sms: "failed" } }])
    expect(h.fake.ofTable("admin_audit_log")).toHaveLength(0)
  })

  it("inserts in-app rows in small chunks (each insert fans out to the mobile push webhook)", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => U(500 + i))
    for (const id of ids) h.users[id] = { role: "user", is_suspended: false, email: `${id}@x.com`, phone_number: null, first_name: "X" }
    const body = await (await POST({ action: "notify", userIds: ids, params: { ...params, channels: ["in_app"] } })).json()
    expect(body.succeeded).toBe(150)
    expect(h.fake.ofTable("notifications").map((q) => (q.payload as any[]).length)).toEqual([100, 50])
  })

  it("a failed audit batch does not stop the others, and the response says how many rows were not written", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => U(700 + i))
    for (const id of ids) h.users[id] = { role: "user", is_suspended: false, email: null as any, phone_number: null, first_name: "X" }
    h.auditFailBatches = 1
    const body = await (await POST({ action: "notify", userIds: ids, params: { ...params, channels: ["in_app"] } })).json()
    expect(h.fake.ofTable("admin_audit_log").map((q) => (q.payload as any[]).length)).toEqual([100, 50])
    expect(body.auditFailed).toBe(100)
  })

  it("'every matching user' is resolved on the server with the list filters (export keyset paging)", async () => {
    h.exportPages = [
      { data: { rows: [{ id: U(1), email: "one@x.com", phone_number: "0244000001", first_name: "One" }], next_cursor: { created_at: "2026-01-01T00:00:00+00:00", id: U(1) } }, error: null },
      { data: { rows: [{ id: U(3), email: "three@x.com", phone_number: null, first_name: "Three" }], next_cursor: null }, error: null },
    ]
    const body = await (await POST({ action: "notify", matching: { role: "user", tag: "vip", sort: "email" }, params: { ...params, channels: ["in_app"] } })).json()
    expect(body).toMatchObject({ total: 2, succeeded: 2 })
    expect(h.fake.rpcCalls.map((c) => c.args)).toEqual([
      expect.objectContaining({ p_role: "user", p_tag: "vip", p_after_created_at: null, p_limit: 1000 }),
      expect.objectContaining({ p_role: "user", p_tag: "vip", p_after_created_at: "2026-01-01T00:00:00+00:00", p_after_id: U(1) }),
    ])
  })

  it("refuses more matching users than one broadcast may reach (5000)", async () => {
    const page = (start: number, more: boolean) => ({
      data: { rows: Array.from({ length: 1000 }, (_, i) => ({ id: U(start + i), email: null, phone_number: null, first_name: null })),
        next_cursor: more ? { created_at: "2026-01-01T00:00:00+00:00", id: U(start) } : null }, error: null,
    })
    h.exportPages = [0, 1, 2, 3, 4, 5].map((n) => page(n * 1000 + 10, true))
    const res = await POST({ action: "notify", matching: {}, params })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/More than 5,000 users match/)
    expect(h.fake.ofTable("notifications")).toHaveLength(0)
    expect(h.fake.ofTable("broadcast_logs")).toHaveLength(0)
  })
})
