import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { makeFakeDb, type FakeDb } from "@/lib/order-queue/fake-db.test-helper"

const h = vi.hoisted(() => ({
  db: null as any,
  verify: vi.fn(),
  build: vi.fn(),
  can: vi.fn(),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => h.db.from(t), rpc: (n: string, a?: any) => h.db.rpc(n, a) }),
}))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: (...a: unknown[]) => h.verify(...a) }))
vi.mock("@/lib/strict-verify/send", () => ({ buildCandidates: (...a: unknown[]) => h.build(...a) }))
vi.mock("@/lib/strict-verify/ask", () => ({ canCheck: (...a: unknown[]) => h.can(...a) }))

import { GET, PUT } from "./route"

const ADMIN = "11111111-2222-4333-8444-555555555555"
const URL_ = "http://localhost/api/admin/settings/strict-supplier-verify"
const get = () => new NextRequest(URL_)
const put = (body: unknown) =>
  new NextRequest(URL_, { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body) })

let db: FakeDb
beforeEach(() => {
  db = makeFakeDb({ admin_settings: [] })
  h.db = db
  h.verify.mockReset()
  h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
  h.build.mockReset()
  h.build.mockResolvedValue({ candidates: ["xpress", "hubnet"], disabled: new Set<string>() })
  h.can.mockReset()
  h.can.mockReturnValue(true)
})

describe("/api/admin/settings/strict-supplier-verify", () => {
  it("rejects non-admins on GET and PUT", async () => {
    h.verify.mockResolvedValue({
      isAdmin: false,
      errorResponse: NextResponse.json({ error: "Admin access required" }, { status: 403 }),
    })
    expect((await GET(get())).status).toBe(403)
    expect((await PUT(put({ enabled: true }))).status).toBe(403)
    expect(db.calls).toEqual([])
  })

  it("PUT with the cron secret (no userId) or a non-uuid id is 403 admin_user_required", async () => {
    h.verify.mockResolvedValue({ isAdmin: true })
    let r = await PUT(put({ enabled: true }))
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: "admin_user_required" })
    h.verify.mockResolvedValue({ isAdmin: true, userId: "not-a-uuid" })
    r = await PUT(put({ enabled: true }))
    expect(r.status).toBe(403)
    expect(db.calls.filter((c) => c.kind !== "select")).toEqual([])
  })

  it("PUT rejects a non-boolean enabled and bad JSON with 400", async () => {
    for (const body of [{ enabled: "yes" }, { enabled: 1 }, {}, "not json"]) {
      expect((await PUT(put(body))).status).toBe(400)
    }
    expect(db.calls.filter((c) => c.kind !== "select")).toEqual([])
  })

  it("PUT upserts the switch with updated_by and returns the new state", async () => {
    const r = await PUT(put({ enabled: true }))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ enabled: true, warnings: [] })
    const row = db.tables.admin_settings.find((x) => x.key === "mtn_strict_supplier_verification")
    expect(row?.value).toEqual({ enabled: true })
    expect(row?.updated_by).toBe(ADMIN)
  })

  it("GET: a missing row is off with no warnings when every sender can check", async () => {
    const r = await GET(get())
    expect(await r.json()).toEqual({ enabled: false, warnings: [] })
  })

  it("GET: stored enabled is returned", async () => {
    db.tables.admin_settings.push({ key: "mtn_strict_supplier_verification", value: { enabled: true } })
    expect((await (await GET(get())).json()).enabled).toBe(true)
  })

  it("GET warns for each sending supplier that cannot check", async () => {
    h.can.mockImplementation((s: string) => s !== "hubnet")
    const r = await GET(get())
    expect((await r.json()).warnings).toEqual([
      "Hubnet can't check numbers right now, so it will receive no MTN orders in strict mode",
    ])
  })

  it("GET returns a generic warning (not a 500) when the supplier settings cannot be read", async () => {
    h.build.mockRejectedValue(new Error("secret db detail"))
    const r = await GET(get())
    expect(r.status).toBe(200)
    expect((await r.json()).warnings).toEqual(["Couldn't read the MTN supplier settings"])
  })

  it("returns no raw DB error text when the save fails", async () => {
    db.failUpsert = () => ({ message: "relation admin_settings secret detail" })
    const r = await PUT(put({ enabled: true }))
    expect(r.status).toBe(500)
    const text = JSON.stringify(await r.json())
    expect(text).not.toContain("secret detail")
  })
})
