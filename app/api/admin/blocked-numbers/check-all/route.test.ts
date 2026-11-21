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
const markAllowed = vi.fn(async (_r: unknown) => ({ updatedIds: [] as string[], failed: false }))
vi.mock("@/lib/blocked-numbers/admin-allow", () => ({ markAllowedByAdminCheck: (r: unknown) => markAllowed(r) }))

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
  markAllowed.mockReset()
  markAllowed.mockResolvedValue({ updatedIds: [], failed: false })
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

  it("outside-only approvals are flipped directly with the first allowing provider, never via recheck", async () => {
    checkAll.mockResolvedValue(result([
      { phone: "0241234567", byCheckout: false, outside: ["b"] },
      { phone: "0551234567", byCheckout: false, outside: ["b"] },
    ]))
    markAllowed.mockResolvedValueOnce({ updatedIds: [ID1, ID2], failed: false })
    const res = await POST(req({ ids: [ID1, ID2] }))
    expect(res.status).toBe(200)
    expect(recheck).not.toHaveBeenCalled()
    expect(markAllowed).toHaveBeenCalledWith([
      { id: ID1, phone: "0241234567", allowedBy: "b" },
      { id: ID2, phone: "0551234567", allowedBy: "b" },
    ])
    const j = await res.json()
    expect(j).toMatchObject({ flipped: 2, flippedOutside: 2, flippedOutsideIds: [ID1, ID2] })
    expect(j.flipFailed).toBeUndefined()
  })

  it("flipped counts checkout and direct flips together", async () => {
    checkAll.mockResolvedValue(result([
      { phone: "0241234567", byCheckout: true, outside: [] },
      { phone: "0551234567", byCheckout: false, outside: ["b"] },
    ]))
    markAllowed.mockResolvedValueOnce({ updatedIds: [ID2], failed: false })
    const j = await (await POST(req({ ids: [ID1, ID2] }))).json()
    expect(j).toMatchObject({ flipped: 2, flippedOutside: 1, flippedOutsideIds: [ID2] })
  })

  it("refused or errored rows never reach the direct flip", async () => {
    checkAll.mockResolvedValue(result([{ phone: "0241234567", byCheckout: false, outside: [] }]))
    handler = () => ({ data: [{ id: ID1, phone: "0241234567" }] })
    const j = await (await POST(req({ ids: [ID1] }))).json()
    expect(markAllowed).not.toHaveBeenCalled()
    expect(recheck).not.toHaveBeenCalled()
    expect(j).toMatchObject({ flipped: 0, flippedOutside: 0 })
  })

  it("a direct-flip failure still returns the rows with flipFailed", async () => {
    checkAll.mockResolvedValue(result([{ phone: "0241234567", byCheckout: false, outside: ["b"] }]))
    handler = () => ({ data: [{ id: ID1, phone: "0241234567" }] })
    markAllowed.mockRejectedValueOnce(new Error("db"))
    const res = await POST(req({ ids: [ID1] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, flipped: 0, flippedOutside: 0, flippedOutsideIds: [], flipFailed: true })
  })

  it("a partial direct-flip error is reported as flipFailed with the rows that did update counted", async () => {
    checkAll.mockResolvedValue(result([{ phone: "0241234567", byCheckout: false, outside: ["b"] }]))
    handler = () => ({ data: [{ id: ID1, phone: "0241234567" }] })
    markAllowed.mockResolvedValueOnce({ updatedIds: [], failed: true })
    expect(await (await POST(req({ ids: [ID1] }))).json()).toMatchObject({ flippedOutside: 0, flippedOutsideIds: [], flipFailed: true })
  })

  it("404 when none of the ids exist", async () => {
    handler = () => ({ data: [] })
    expect((await POST(req({ ids: [ID1] }))).status).toBe(404)
    expect(checkAll).not.toHaveBeenCalled()
  })
})

describe("check-all route hardening", () => {
  it("a recheck failure still returns the provider rows with flipped 0 and recheckFailed", async () => {
    checkAll.mockResolvedValue(result([
      { phone: "0241234567", byCheckout: true, outside: [] },
      { phone: "0551234567", byCheckout: false, outside: [] },
    ]))
    recheck.mockRejectedValueOnce(new Error("db down"))
    const res = await POST(req({ ids: [ID1, ID2] }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({ success: true, flipped: 0, recheckFailed: true })
    expect(j.rows).toHaveLength(2)
  })

  it("dedupes phones by normalised number before asking providers and maps results to every row", async () => {
    handler = () => ({ data: [{ id: ID1, phone: "0241234567" }, { id: ID2, phone: "+233241234567" }] })
    checkAll.mockResolvedValue(result([{ phone: "0241234567", byCheckout: true, outside: [] }]))
    const res = await POST(req({ ids: [ID1, ID2] }))
    expect(checkAll).toHaveBeenCalledWith(["0241234567"])
    const j = await res.json()
    expect(j.rows.map((r: { id: string; allowedByCheckout: boolean }) => [r.id, r.allowedByCheckout])).toEqual([[ID1, true], [ID2, true]])
    expect(recheck).toHaveBeenCalledWith({ ids: [ID1, ID2], reopenExpired: true })
  })

  it("passes failedProviders through", async () => {
    handler = () => ({ data: [{ id: ID1, phone: "0241234567" }] })
    checkAll.mockResolvedValue({ ...result([{ phone: "0241234567", byCheckout: false, outside: [] }]), failedProviders: ["b"] })
    const j = await (await POST(req({ ids: [ID1] }))).json()
    expect(j.failedProviders).toEqual(["b"])
  })

  it("runs up to 300 s", async () => {
    const mod = await import("./route")
    expect(mod.maxDuration).toBe(300)
  })
})
