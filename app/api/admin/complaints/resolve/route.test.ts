import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { makeFakeDb, type FakeCall, type FakeResult } from "../../../support/_fake-db"

const h = vi.hoisted(() => ({ client: null as any, auth: null as any }))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => h.client[k] }) }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => h.auth) }))
vi.mock("@/lib/admin-actions", () => ({ notifyUserOfOutcome: vi.fn(async () => []) }))
vi.mock("@/lib/support-notify", () => ({ runAfterResponse: (task: () => Promise<void>) => { void task() } }))

import { POST } from "./route"
import { notifyUserOfOutcome } from "@/lib/admin-actions"

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const ATTACKER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const ID = "55555555-5555-4555-8555-555555555555"
const ORDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

let fake: ReturnType<typeof makeFakeDb>

function install(row: any, extra: (c: FakeCall) => FakeResult | undefined = () => undefined) {
  fake = makeFakeDb((c) => {
    const o = extra(c)
    if (o) return o
    if (c.table === "complaints" && c.op === "select") return { data: row }
    if (c.table === "complaints" && c.op === "update") return { data: [{ id: ID, user_id: OWNER, order_id: ORDER }] }
    return undefined
  })
  h.client = fake.db
}

const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/admin/complaints/resolve", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }))

const ok = { id: ID, status: "resolved", resolution_notes: "  Sorted.  " }

beforeEach(() => {
  vi.clearAllMocks()
  h.auth = { isAdmin: true, userId: ADMIN }
  install({ id: ID, user_id: OWNER, order_id: ORDER, status: "pending" })
})

describe("POST /api/admin/complaints/resolve", () => {
  it("refuses a non-admin before touching the database", async () => {
    h.auth = { isAdmin: false, errorResponse: NextResponse.json({ error: "Admin access required" }, { status: 403 }) }
    expect((await post(ok)).status).toBe(403)
    expect(fake.calls).toHaveLength(0)
  })

  it("401 for the cron-secret caller without a user id", async () => {
    h.auth = { isAdmin: true }
    expect((await post(ok)).status).toBe(401)
    expect(fake.calls).toHaveLength(0)
  })

  it("400 when the body tries to set status pending", async () => {
    const res = await post({ ...ok, status: "pending" })
    expect(res.status).toBe(400)
    expect(fake.calls).toHaveLength(0)
  })

  it("400 for notes over 2000 chars, a bad id and malformed JSON", async () => {
    expect((await post({ ...ok, resolution_notes: "x".repeat(2001) })).status).toBe(400)
    expect((await post({ ...ok, id: "nope" })).status).toBe(400)
    expect((await post("{not json")).status).toBe(400)
    expect(fake.calls).toHaveLength(0)
  })

  it("404 when the complaint does not exist", async () => {
    install(null)
    expect((await post(ok)).status).toBe(404)
    expect(notifyUserOfOutcome).not.toHaveBeenCalled()
  })

  it.each(["resolved", "rejected"])("409 and no notification when the row is already %s", async (status) => {
    install({ id: ID, user_id: OWNER, order_id: null, status })
    const res = await post(ok)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("This complaint is already resolved")
    expect(fake.calls.some((c) => c.op === "update")).toBe(false)
    expect(notifyUserOfOutcome).not.toHaveBeenCalled()
  })

  it("409 with no notification when the guarded update matches zero rows (lost the race)", async () => {
    install({ id: ID, user_id: OWNER, order_id: null, status: "pending" }, (c) => (c.op === "update" ? { data: [] } : undefined))
    expect((await post(ok)).status).toBe(409)
    expect(notifyUserOfOutcome).not.toHaveBeenCalled()
  })

  it("updates with a status guard, trimmed notes and updated_at", async () => {
    const res = await post(ok)
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    const upd = fake.calls.find((c) => c.op === "update")!
    expect(upd.payload).toMatchObject({ status: "resolved", resolution_notes: "Sorted." })
    expect(typeof upd.payload.updated_at).toBe("string")
    expect(upd.filters).toContainEqual(["id", ID])
    expect(upd.filters).toContainEqual(["status:in", ["pending", "in_review"]])
  })

  it("notifies the row's owner, ignoring any user id in the body", async () => {
    await post({ ...ok, user_id: ATTACKER, userId: ATTACKER })
    await Promise.resolve()
    expect(notifyUserOfOutcome).toHaveBeenCalledTimes(1)
    expect(notifyUserOfOutcome).toHaveBeenCalledWith(
      "complaint",
      "resolved",
      { userId: OWNER, reference: ID },
      { complaintId: ID, orderId: ORDER, resolutionNotes: "Sorted." },
    )
  })

  it("still succeeds when the notification throws", async () => {
    vi.mocked(notifyUserOfOutcome).mockRejectedValueOnce(new Error("down"))
    expect((await post({ ...ok, status: "rejected" })).status).toBe(200)
  })

  it("500 generic when the update errors", async () => {
    install({ id: ID, user_id: OWNER, order_id: null, status: "pending" }, (c) =>
      c.op === "update" ? { error: { message: "secret detail" } } : undefined,
    )
    const res = await post(ok)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret")
  })
})
