import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { makeFakeTtb } from "@/lib/text-to-buy/fake-db.test-helper"
import { encodeCursor } from "@/lib/text-to-buy/admin-view"

const h = vi.hoisted(() => ({ client: null as unknown }))
vi.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return h.client
  },
}))
const authMock = vi.fn()
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: (...a: unknown[]) => authMock(...a) }))

import { GET } from "./route"

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const S1 = "0200000101"
const S2 = "0200000102"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const get = (qs = "") => GET(new NextRequest(`http://localhost/api/admin/text-to-buy/messages${qs}`, { headers: { authorization: "Bearer tok" } }))
const msg = (n: number, at: string, extra: Record<string, unknown> = {}) => ({
  id: id(n), line: "main", sender: S1, direction: "in", body: `text ${n}`, created_at: at, misread: false, ...extra,
})

let fake: ReturnType<typeof makeFakeTtb>
const world = (rows: Record<string, unknown>[]) => {
  fake = makeFakeTtb({ ttb_messages: rows })
  h.client = fake.client
}
let errSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.clearAllMocks()
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-placeholder"
  authMock.mockResolvedValue({ isAdmin: true, userId: ADMIN })
  world([])
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("auth", () => {
  it("401 passthrough, 403 for a non-admin, and 403 for the cron bearer (customer text needs a real admin user)", async () => {
    authMock.mockResolvedValue({ errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await get()).status).toBe(401)
    authMock.mockResolvedValue({ isAdmin: false, userId: "u1" })
    expect((await get()).status).toBe(403)
    authMock.mockResolvedValue({ isAdmin: true })
    const res = await get()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("admin_user_required")
  })
  it("503 without the service role", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    expect((await get()).status).toBe(503)
  })
})

describe("list", () => {
  it("returns inbound rows only, newest first, with the response fields and no-store", async () => {
    world([
      msg(1, "2026-11-13T10:00:00Z", { outcome: "prompted", read_by: "ai", order_link_id: id(77) }),
      msg(2, "2026-11-13T10:01:00Z", { direction: "out" }),
      msg(3, "2026-11-13T10:02:00Z"),
    ])
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await res.json()
    expect(body.rows.map((r: { id: string }) => r.id)).toEqual([id(3), id(1)])
    expect(body.rows[1]).toEqual({
      id: id(1), createdAt: "2026-11-13T10:00:00Z", line: "main", sender: S1, direction: "in", body: "text 1",
      readBy: "ai", outcome: "prompted", orderLinkId: id(77), misread: false,
    })
    expect(body.nextCursor).toBeNull()
  })
  it("filters by line, sender (any form) and outcome", async () => {
    world([
      msg(1, "2026-11-13T10:00:00Z", { outcome: "prompted" }),
      msg(2, "2026-11-13T10:01:00Z", { outcome: "not_order", sender: S2 }),
      msg(3, "2026-11-13T10:02:00Z", { line: "shop" }),
    ])
    const ids = async (qs: string) => (await (await get(qs)).json()).rows.map((r: { id: string }) => r.id)
    expect(await ids("?line=shop")).toEqual([id(3)])
    expect(await ids("?sender=%2B233200000102")).toEqual([id(2)])
    expect(await ids("?outcome=prompted")).toEqual([id(1)])
    expect(await ids("?line=main&outcome=not_order&sender=0200000102")).toEqual([id(2)])
  })
  it("rejects a bad line, sender, outcome, cursor or limit", async () => {
    for (const [qs, err] of [
      ["?line=other", "invalid_line"], ["?sender=123", "invalid_sender"], ["?outcome=bogus", "invalid_outcome"],
      ["?cursor=garbage", "invalid_cursor"], ["?limit=0", "invalid_limit"], ["?limit=101", "invalid_limit"],
      ["?limit=abc", "invalid_limit"], ["?limit=-5", "invalid_limit"], ["?limit=1.5", "invalid_limit"],
    ] as const) {
      const res = await get(qs)
      expect([qs, res.status]).toEqual([qs, 400])
      expect((await res.json()).error).toBe(err)
    }
  })
  it("limit 1..100 is honoured and the default is 50", async () => {
    world(Array.from({ length: 120 }, (_, i) => msg(i + 1, new Date(Date.UTC(2026, 10, 13, 10, 0, i)).toISOString())))
    expect((await (await get()).json()).rows).toHaveLength(50)
    expect((await (await get("?limit=100")).json()).rows).toHaveLength(100)
    expect((await (await get("?limit=1")).json()).rows).toHaveLength(1)
  })
  it("pages through every row exactly once, including rows that share a created_at", async () => {
    const same = "2026-11-13T10:05:00.123456Z"
    world([
      msg(1, "2026-11-13T10:00:00Z"), msg(2, same), msg(3, same), msg(4, same), msg(5, "2026-11-13T10:09:00Z"),
      msg(6, "2026-11-13T10:04:00Z"), msg(7, same), msg(8, "2026-11-13T10:01:00Z"),
    ])
    const seen: string[] = []
    let qs = "?limit=3"
    for (let i = 0; i < 10; i++) {
      const body = await (await get(qs)).json()
      seen.push(...body.rows.map((r: { id: string }) => r.id))
      if (!body.nextCursor) break
      qs = `?limit=3&cursor=${encodeURIComponent(body.nextCursor)}`
    }
    expect(seen).toEqual([id(5), id(7), id(4), id(3), id(2), id(6), id(8), id(1)])
    expect(new Set(seen).size).toBe(8)
  })
  it("a well-formed cursor that points at nothing returns an empty page", async () => {
    world([msg(1, "2026-11-13T10:00:00Z")])
    const body = await (await get(`?cursor=${encodeURIComponent(encodeCursor("2026-11-13T09:00:00Z", id(5)))}`)).json()
    expect(body).toEqual({ rows: [], nextCursor: null })
  })
})

describe("thread", () => {
  it("returns both directions for one sender, oldest first", async () => {
    world([
      msg(1, "2026-11-13T10:00:00Z"),
      msg(2, "2026-11-13T10:00:05Z", { direction: "out", body: "reply" }),
      msg(3, "2026-11-13T10:01:00Z", { sender: S2 }),
      msg(4, "2026-11-13T10:02:00Z", { line: "shop" }),
    ])
    const body = await (await get("?thread=%2B233200000101&line=main")).json()
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual([id(1), id(2)])
    expect(body.messages[1]).toMatchObject({ direction: "out", body: "reply" })
    expect((await (await get(`?thread=${S1}`)).json()).messages).toHaveLength(3)
  })
  it("caps at the latest 200 rows", async () => {
    world(Array.from({ length: 230 }, (_, i) => msg(i + 1, new Date(Date.UTC(2026, 10, 13, 8, 0, i)).toISOString())))
    const body = await (await get(`?thread=${S1}`)).json()
    expect(body.messages).toHaveLength(200)
    expect(body.messages[0].id).toBe(id(31))
    expect(body.messages[199].id).toBe(id(230))
  })
  it("rejects a bad thread sender or line", async () => {
    expect((await get("?thread=123")).status).toBe(400)
    expect((await get(`?thread=${S1}&line=nope`)).status).toBe(400)
  })
})

describe("errors", () => {
  it("a database failure is a 500 that leaks nothing and logs a code only", async () => {
    fake.db.failOn.ttb_messages = { message: "body text 0200000101" }
    const res = await get(`?sender=${S1}`)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("0200000101")
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain("0200000101")
    expect(JSON.stringify(errSpy.mock.calls)).toContain("[TTB-ADMIN] messages failed code=-")
  })
})
