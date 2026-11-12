import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { makeFakeDb, type FakeCall, type FakeResult } from "../../../../support/_fake-db"

const h = vi.hoisted(() => ({ client: null as any, auth: null as any }))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => h.client[k] }) }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => h.auth) }))
vi.mock("@/lib/admin-presence", () => ({ touchAdminPresence: vi.fn(async () => {}) }))
vi.mock("@/lib/support-attachment", () => ({ signAttachmentUrl: vi.fn(async (_db: unknown, p: string | null) => (p ? `https://signed/${p}` : null)) }))
vi.mock("@/lib/support-notify", () => ({
  notifyUserSupportEvent: vi.fn(async () => {}),
  runAfterResponse: (task: () => Promise<void>) => { void task() },
}))

import { GET, POST } from "./route"
import { notifyUserSupportEvent } from "@/lib/support-notify"
import { touchAdminPresence } from "@/lib/admin-presence"

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const THREAD = "44444444-4444-4444-8444-444444444444"

let fake: ReturnType<typeof makeFakeDb>

function install(thread: any, extra: (c: FakeCall) => FakeResult | undefined = () => undefined) {
  fake = makeFakeDb((c) => {
    const o = extra(c)
    if (o) return o
    if (c.table === "support_threads" && c.op === "select") return { data: thread }
    if (c.table === "support_messages" && c.op === "insert") return { data: { id: "m1", created_at: "2026-11-12T10:00:00Z" } }
    if (c.table === "support_threads" && c.op === "update" && c.payload?.status === "closed") return { data: [{ id: THREAD }] }
    return undefined
  })
  h.client = fake.db
}

const get = (id = THREAD) =>
  GET(new NextRequest(`http://localhost/api/admin/support/threads/${id}`), { params: Promise.resolve({ id }) })
const post = (body: unknown, id = THREAD) =>
  POST(new NextRequest(`http://localhost/api/admin/support/threads/${id}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.auth = { isAdmin: true, userId: ADMIN }
  install({ id: THREAD, user_id: OWNER, status: "open" })
})

describe("auth", () => {
  it("returns the errorResponse for a non-admin on GET and POST", async () => {
    h.auth = { isAdmin: false, errorResponse: NextResponse.json({ error: "Admin access required" }, { status: 403 }) }
    expect((await get()).status).toBe(403)
    expect((await post({ action: "read" })).status).toBe(403)
    expect(fake.calls).toHaveLength(0)
  })

  it("401 for an admin result without a userId (cron secret)", async () => {
    h.auth = { isAdmin: true }
    expect((await get()).status).toBe(401)
    expect((await post({ action: "reply", message: "hi" })).status).toBe(401)
    expect(fake.calls).toHaveLength(0)
  })
})

describe("GET /threads/[id]", () => {
  it("400 for a non-UUID id and 404 for a missing thread", async () => {
    expect((await get("nope")).status).toBe(400)
    install(null)
    expect((await get()).status).toBe(404)
  })

  it("returns messages with counterpart receipts and a signed url, without raw columns", async () => {
    install({ id: THREAD, user_id: OWNER, status: "open", order_id: null, shop_order_id: null }, (c) => {
      if (c.table === "users") return { data: [{ id: OWNER, first_name: "A", last_name: "B", email: "a@b.c", phone_number: "0241234567" }] }
      if (c.table === "support_messages" && c.op === "select")
        return {
          data: [
            { id: "m1", sender_role: "user", body: "help", attachment_path: "threads/x.png", created_at: "1", delivered_to_user_at: null, delivered_to_admin_at: "d", read_by_user_at: null, read_by_admin_at: "r" },
            { id: "m2", sender_role: "admin", body: "ok", attachment_path: null, created_at: "2", delivered_to_user_at: "du", delivered_to_admin_at: null, read_by_user_at: null, read_by_admin_at: null },
          ],
        }
      return undefined
    })
    const res = await get()
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.user.email).toBe("a@b.c")
    expect(data.messages[0]).toEqual({ id: "m1", sender_role: "user", body: "help", created_at: "1", delivered_at: "d", read_at: "r", attachment_url: "https://signed/threads/x.png" })
    expect(data.messages[1].delivered_at).toBe("du")
    expect(data.messages[1].read_at).toBeNull()
    expect(JSON.stringify(data.messages)).not.toContain("attachment_path")
    expect(JSON.stringify(data.messages)).not.toContain("read_by_admin_at")
    expect(touchAdminPresence).toHaveBeenCalled()
  })

  it("marks unread-delivery user messages as delivered to admin, scoped to the thread", async () => {
    await get()
    const upd = fake.calls.find((c) => c.table === "support_messages" && c.op === "update")!
    expect(Object.keys(upd.payload)).toEqual(["delivered_to_admin_at"])
    expect(upd.filters).toContainEqual(["thread_id", THREAD])
    expect(upd.filters).toContainEqual(["sender_role", "user"])
    expect(upd.filters).toContainEqual(["delivered_to_admin_at:is", null])
  })
})

describe("POST /threads/[id]", () => {
  it("400 for bad id, bad json and bad action; 404 for a missing thread", async () => {
    expect((await post({ action: "read" }, "nope")).status).toBe(400)
    expect((await post("{not json")).status).toBe(400)
    expect((await post({ action: "delete" })).status).toBe(400)
    expect((await post({ action: "reply", message: "" })).status).toBe(400)
    install(null)
    expect((await post({ action: "read" })).status).toBe(404)
  })

  it("reply to a closed thread is 409 with no insert and no notification", async () => {
    install({ id: THREAD, user_id: OWNER, status: "closed" })
    expect((await post({ action: "reply", message: "hello" })).status).toBe(409)
    expect(fake.calls.some((c) => c.op === "insert")).toBe(false)
    expect(notifyUserSupportEvent).not.toHaveBeenCalled()
  })

  it("reply inserts as the admin, sets handler human and notifies the row's owner, ignoring body user_id", async () => {
    const res = await post({ action: "reply", message: "hello", user_id: OTHER, sender_id: OTHER, thread_id: OTHER })
    expect(res.status).toBe(201)
    const ins = fake.calls.find((c) => c.table === "support_messages" && c.op === "insert")!
    expect(ins.payload).toEqual({ thread_id: THREAD, sender_role: "admin", sender_id: ADMIN, body: "hello" })
    const upd = fake.calls.find((c) => c.table === "support_threads" && c.op === "update")!
    expect(upd.payload).toEqual({ handler: "human" })
    expect(upd.filters).toContainEqual(["id", THREAD])
    expect(notifyUserSupportEvent).toHaveBeenCalledWith(expect.anything(), OWNER, "replied", THREAD)
  })

  it("close with a note inserts the note before the guarded update, then notifies the owner", async () => {
    const res = await post({ action: "close", note: "Resolved, thanks", user_id: OTHER })
    expect(res.status).toBe(200)
    const order = fake.calls.map((c) => `${c.table}:${c.op}`)
    expect(order.indexOf("support_messages:insert")).toBeLessThan(order.lastIndexOf("support_threads:update"))
    const upd = fake.calls.find((c) => c.table === "support_threads" && c.op === "update")!
    expect(upd.payload).toMatchObject({ status: "closed", closed_by: ADMIN })
    expect(upd.filters).toContainEqual(["id", THREAD])
    expect(upd.filters).toContainEqual(["status", "open"])
    expect(notifyUserSupportEvent).toHaveBeenCalledWith(expect.anything(), OWNER, "closed", THREAD)
  })

  it("close of an already-closed thread is 409 without writes", async () => {
    install({ id: THREAD, user_id: OWNER, status: "closed" })
    expect((await post({ action: "close" })).status).toBe(409)
    expect(fake.calls.some((c) => c.op !== "select")).toBe(false)
  })

  it("close that loses the race (zero rows) is 409 and sends no notification", async () => {
    install({ id: THREAD, user_id: OWNER, status: "open" }, (c) =>
      c.table === "support_threads" && c.op === "update" ? { data: [] } : undefined,
    )
    const res = await post({ action: "close" })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("This complaint is already closed")
    expect(notifyUserSupportEvent).not.toHaveBeenCalled()
  })

  it("read marks only the thread's unread user messages", async () => {
    expect((await post({ action: "read" })).status).toBe(200)
    const upd = fake.calls.find((c) => c.table === "support_messages" && c.op === "update")!
    expect(Object.keys(upd.payload).sort()).toEqual(["delivered_to_admin_at", "read_by_admin_at"])
    expect(upd.filters).toContainEqual(["thread_id", THREAD])
    expect(upd.filters).toContainEqual(["sender_role", "user"])
    expect(upd.filters).toContainEqual(["read_by_admin_at:is", null])
    expect(touchAdminPresence).toHaveBeenCalled()
    expect(notifyUserSupportEvent).not.toHaveBeenCalled()
  })

  it("500 with a generic message when the database fails", async () => {
    install({ id: THREAD, user_id: OWNER, status: "open" }, (c) =>
      c.table === "support_messages" && c.op === "insert" ? { error: { message: "secret detail" } } : undefined,
    )
    const res = await post({ action: "reply", message: "hello" })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret")
  })
})
