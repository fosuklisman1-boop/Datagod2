import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextResponse } from "next/server"
import { makeFakeDb, hasCall, type Call, type FakeResult } from "@/lib/blocked-numbers/test-db"

const ID1 = "123e4567-e89b-12d3-a456-426614174001"
const ID2 = "123e4567-e89b-12d3-a456-426614174002"

let admin = true
let handler: (table: string, calls: Call[]) => FakeResult = () => ({})
let fake = makeFakeDb((t, c) => handler(t, c))
const recheck = vi.fn(async (_o: unknown) => ({
  checked: 1, allowed: 1, stillBlocked: 0, unchecked: 0, expired: 0, deferred: 0, newlyAllowedIds: [ID1],
}))
const checkAll = vi.fn()

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () =>
    admin
      ? { isAdmin: true, userId: "admin-1", userEmail: "a@x.test" }
      : { isAdmin: false, errorResponse: NextResponse.json({ error: "Admin access required" }, { status: 403 }) }
  ),
}))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (t: string) => fake.db.from(t) } }))
vi.mock("@/lib/blocked-numbers/recheck", () => ({ recheckBlockedNumbers: (o: unknown) => recheck(o) }))
vi.mock("@/lib/blocked-numbers/all-providers", () => ({ checkAllProviders: (p: string[]) => checkAll(p) }))

import { POST } from "./route"

const req = (body: unknown) => new Request("http://x/api/admin/blocked-numbers/check-all", { method: "POST", body: JSON.stringify(body) }) as never

const result = (rows: Array<{ phone: string; byCheckout: boolean; outside: string[] }>) => ({
  providers: ["a", "b"],
  checkoutProviders: ["a"],
  rows: rows.map((r) => ({
    phone: r.phone,
    results: { a: r.byCheckout ? "allowed" : "refused", b: r.outside.length ? "allowed" : "refused" },
    allowedByCheckout: r.byCheckout,
    allowedOutsideCheckout: r.outside,
  })),
})

beforeEach(() => {
  admin = true
  fake = makeFakeDb((t, c) => handler(t, c))
  handler = () => ({ data: [{ id: ID1, phone: "0241234567" }, { id: ID2, phone: "0551234567" }] })
  recheck.mockClear()
  checkAll.mockReset()
})

describe("check-all route", () => {
  it("rejects non-admins before doing anything", async () => {
    admin = false
    expect((await POST(req({ ids: [ID1] }))).status).toBe(403)
    expect(checkAll).not.toHaveBeenCalled()
    expect(recheck).not.toHaveBeenCalled()
    expect(fake.log).toHaveLength(0)
  })

  it("more than 100 ids is a 400", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `123e4567-e89b-12d3-a456-${String(i).padStart(12, "0")}`)
    expect((await POST(req({ ids }))).status).toBe(400)
    expect(checkAll).not.toHaveBeenCalled()
  })

  it("rejects bad bodies", async () => {
    expect((await POST(req({ ids: ["nope"] }))).status).toBe(400)
    expect((await POST(req({ all: true }))).status).toBe(400)
  })

  it("recheck runs only with the checkout-allowed ids", async () => {
    checkAll.mockResolvedValue(result([
      { phone: "0241234567", byCheckout: true, outside: [] },
      { phone: "0551234567", byCheckout: false, outside: ["b"] },
    ]))
    const res = await POST(req({ ids: [ID1, ID2] }))
    expect(res.status).toBe(200)
    expect(hasCall(fake.log[0].calls, "in", "id", [ID1, ID2])).toBe(true)
    expect(recheck).toHaveBeenCalledWith({ ids: [ID1], reopenExpired: true })
    const j = await res.json()
    expect(j.flipped).toBe(1)
    expect(j.rows).toEqual([
      expect.objectContaining({ id: ID1, phone: "0241234567", allowedByCheckout: true }),
      expect.objectContaining({ id: ID2, phone: "0551234567", allowedByCheckout: false, allowedOutsideCheckout: ["b"] }),
    ])
    expect(j.providers).toEqual(["a", "b"])
    expect(j.checkoutProviders).toEqual(["a"])
  })

  it("approvals outside the checkout list never call recheck", async () => {
    checkAll.mockResolvedValue(result([
      { phone: "0241234567", byCheckout: false, outside: ["b"] },
      { phone: "0551234567", byCheckout: false, outside: ["b"] },
    ]))
    const res = await POST(req({ ids: [ID1, ID2] }))
    expect(res.status).toBe(200)
    expect(recheck).not.toHaveBeenCalled()
    expect((await res.json()).flipped).toBe(0)
  })

  it("404 when none of the ids exist", async () => {
    handler = () => ({ data: [] })
    expect((await POST(req({ ids: [ID1] }))).status).toBe(404)
    expect(checkAll).not.toHaveBeenCalled()
  })
})
