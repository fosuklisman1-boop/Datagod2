import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { makeFakeDb, type FakeCall } from "../../../support/_fake-db"

const h = vi.hoisted(() => ({ client: null as any, auth: null as any }))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => h.client[k] }) }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => h.auth) }))
vi.mock("@/lib/admin-presence", () => ({ touchAdminPresence: vi.fn(async () => {}) }))

import { GET } from "./route"
import { touchAdminPresence } from "@/lib/admin-presence"

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
let fake: ReturnType<typeof makeFakeDb>
let threadCall: FakeCall | undefined

beforeEach(() => {
  vi.clearAllMocks()
  h.auth = { isAdmin: true, userId: ADMIN }
  threadCall = undefined
  fake = makeFakeDb((c) => {
    if (c.table === "support_threads") {
      threadCall = c
      return { data: [{ id: "t1", user_id: "u1", order_id: null, shop_order_id: null, status: "open" }] }
    }
    if (c.table === "users") return { data: [{ id: "u1", first_name: "A", last_name: "B", email: "a@b.c", phone_number: "0241234567" }] }
    return { data: [] }
  })
  h.client = fake.db
})

const get = (qs = "") => GET(new NextRequest(`http://localhost/api/admin/support/threads${qs}`))

describe("GET /api/admin/support/threads", () => {
  it("returns the errorResponse for a non-admin and 401 for a user-less admin", async () => {
    h.auth = { isAdmin: false, errorResponse: NextResponse.json({ error: "Admin access required" }, { status: 403 }) }
    expect((await get()).status).toBe(403)
    h.auth = { isAdmin: true }
    expect((await get()).status).toBe(401)
    expect(fake.calls).toHaveLength(0)
  })

  it("defaults to open threads and touches presence", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).data.threads[0].user.email).toBe("a@b.c")
    expect(threadCall!.filters).toEqual([["status", "open"]])
    expect(touchAdminPresence).toHaveBeenCalledWith(expect.anything(), ADMIN)
  })

  it("status=all&days=7 builds the open-or-recent filter", async () => {
    await get("?status=all&days=7")
    const or = threadCall!.filters.find(([k]) => k === "or")![1] as string
    const m = or.match(/^status\.eq\.open,last_message_at\.gte\.(.+)$/)
    expect(m).not.toBeNull()
    const ageDays = (Date.now() - Date.parse(m![1])) / 86_400_000
    expect(ageDays).toBeGreaterThan(6.99)
    expect(ageDays).toBeLessThan(7.01)
  })

  it("clamps days to 1..90", async () => {
    const age = async (qs: string) => {
      await get(qs)
      const since = threadCall!.filters.find(([k]) => k === "last_message_at:gte")![1] as string
      return Math.round((Date.now() - Date.parse(since)) / 86_400_000)
    }
    expect(await age("?status=closed&days=500")).toBe(90)
    expect(await age("?status=closed&days=0")).toBe(1)
  })

  it("500 with a generic message on a database error", async () => {
    h.client = makeFakeDb(() => ({ error: { message: "secret detail" } })).db
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret")
  })
})
