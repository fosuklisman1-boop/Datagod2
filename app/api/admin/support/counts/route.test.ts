import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { makeFakeDb } from "../../../support/_fake-db"

const h = vi.hoisted(() => ({ client: null as any, auth: null as any }))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => h.client[k] }) }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => h.auth) }))

import { GET } from "./route"

let fake: ReturnType<typeof makeFakeDb>
const get = () => GET(new NextRequest("http://localhost/api/admin/support/counts"))

beforeEach(() => {
  h.auth = { isAdmin: true, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }
  fake = makeFakeDb((c) => ({ count: c.table === "support_threads" ? 4 : c.table === "support_messages" ? 9 : 2 }))
  h.client = fake.db
})

describe("GET /api/admin/support/counts", () => {
  it("rejects non-admins and user-less admins", async () => {
    h.auth = { isAdmin: false, errorResponse: NextResponse.json({ error: "Admin access required" }, { status: 403 }) }
    expect((await get()).status).toBe(403)
    h.auth = { isAdmin: true }
    expect((await get()).status).toBe(401)
    expect(fake.calls).toHaveLength(0)
  })

  it("returns head-only counts with the right filters", async () => {
    const res = await get()
    expect((await res.json()).data).toEqual({ openThreads: 4, unreadMessages: 9, legacyPending: 2 })
    expect(fake.calls).toHaveLength(3)
    for (const c of fake.calls) expect(c.selectOpts).toEqual({ count: "exact", head: true })
    const msgs = fake.calls.find((c) => c.table === "support_messages")!
    expect(msgs.filters).toContainEqual(["sender_role", "user"])
    expect(msgs.filters).toContainEqual(["read_by_admin_at:is", null])
    expect(fake.calls.find((c) => c.table === "complaints")!.filters).toContainEqual(["status:in", ["pending", "in_review"]])
  })

  it("500 when a count query fails", async () => {
    h.client = makeFakeDb(() => ({ error: { message: "boom" } })).db
    expect((await get()).status).toBe(500)
  })
})
