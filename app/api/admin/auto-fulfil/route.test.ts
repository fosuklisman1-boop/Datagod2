import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { makeFakeDb, type FakeDb } from "@/lib/order-queue/fake-db.test-helper"
import { AUTO_FULFIL_SETTINGS_KEY, DEFAULT_AUTO_FULFIL_SETTINGS } from "@/lib/auto-fulfil/settings"
import { NON_SEND_SWITCHED_OFF } from "@/lib/auto-fulfil/policy"

const h = vi.hoisted(() => ({ db: null as any, verify: vi.fn() }))
// The route builds its client at import time; delegate to the per-test fake.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => h.db.from(t), rpc: (n: string, a?: any) => h.db.rpc(n, a) }),
}))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: (...a: unknown[]) => h.verify(...a) }))

import { GET, PUT } from "./route"

const ADMIN = "11111111-2222-4333-8444-555555555555"
const URL_ = "http://localhost/api/admin/auto-fulfil"
const get = () => new NextRequest(URL_)
const put = (body: unknown) =>
  new NextRequest(URL_, { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body) })
const settings = (over: Record<string, unknown> = {}) => ({ ...structuredClone(DEFAULT_AUTO_FULFIL_SETTINGS), ...over })

let db: FakeDb
beforeEach(() => {
  db = makeFakeDb({
    admin_settings: [
      { key: "mtn_auto_fulfillment_enabled", value: { enabled: true } },
      { key: "auto_fulfillment_enabled", value: { enabled: true, networks: ["Telecel", "at-ishare"] } },
    ],
    auto_fulfil_runs: [
      { id: "r1", started_at: "2026-11-22T10:00:00Z", finished_at: "2026-11-22T10:00:05Z", queued: 1, waiting: 0, needs_you: 0, skipped: { blacklisted: 2 }, error: null },
      { id: "r2", started_at: "2026-11-22T10:05:00Z", finished_at: "2026-11-22T10:05:04Z", queued: 3, waiting: 2, needs_you: 1, skipped: { blacklisted: 1 }, error: null },
    ],
    fulfillment_queue: [
      { id: "q1", order_id: "o1", source: "auto", status: "pending" },
      { id: "q2", order_id: "o2", source: "auto", status: "processing" },
      { id: "q3", order_id: "o3", source: "admin", status: "pending" },
    ],
    auto_fulfil_settings_log: [],
  })
  h.db = db
  h.verify.mockReset()
  h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
})

const writes = () => db.calls.filter((c) => c.kind !== "select")

describe("/api/admin/auto-fulfil", () => {
  it("GET and PUT return the verifyAdminAccess error for non-admins", async () => {
    h.verify.mockImplementation(async () => ({
      isAdmin: false,
      errorResponse: NextResponse.json({ error: "Admin access required" }, { status: 403 }),
    }))
    const g = await GET(get())
    expect(g.status).toBe(403)
    expect(await g.json()).toEqual({ error: "Admin access required" })
    const p = await PUT(put(settings({ enabled: true })))
    expect(p.status).toBe(403)
    expect(await p.json()).toEqual({ error: "Admin access required" })
    expect(db.calls).toEqual([])
  })

  it("GET returns settings, switches, the latest run (counts only) and the waiting auto row count", async () => {
    const r = await GET(get())
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body).toEqual({
      settings: DEFAULT_AUTO_FULFIL_SETTINGS,
      valid: true,
      switches: { mtn: true, nonMtn: { enabled: true, networks: ["Telecel", "AT - iShare"] } },
      lastRun: { startedAt: "2026-11-22T10:05:00Z", finishedAt: "2026-11-22T10:05:04Z", queued: 3, waiting: 2, needsYou: 1, error: null },
      waitingAutoRows: 1,
    })
    expect(JSON.stringify(body)).not.toContain("blacklisted")
  })

  it("GET with no runs => lastRun null; switches off when rows are missing", async () => {
    db.tables.auto_fulfil_runs = []
    db.tables.admin_settings = []
    const body = await (await GET(get())).json()
    expect(body.lastRun).toBeNull()
    expect(body.switches).toEqual({ mtn: false, nonMtn: { enabled: false, networks: [] } })
  })

  it("GET with garbled stored settings => 200, valid false, defaults returned", async () => {
    db.tables.admin_settings.push({ key: AUTO_FULFIL_SETTINGS_KEY, value: { enabled: "yes", minAgeMinutes: 1 } })
    const r = await GET(get())
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.valid).toBe(false)
    expect(body.settings).toEqual({ ...DEFAULT_AUTO_FULFIL_SETTINGS, enabled: false })
  })

  it("GET read failure => 500 with a generic message (no raw DB text)", async () => {
    db.failSelect = (t) => (t === "auto_fulfil_runs" ? { message: "relation secret_x does not exist" } : null)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const r = await GET(get())
      expect(r.status).toBe(500)
      expect(JSON.stringify(await r.json())).not.toContain("secret_x")
    } finally {
      err.mockRestore()
    }
  })

  it("PUT with cron-secret auth (no userId) => 403 admin_user_required", async () => {
    h.verify.mockResolvedValue({ isAdmin: true })
    const r = await PUT(put(settings({ enabled: true })))
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: "admin_user_required" })
    expect(writes()).toEqual([])
  })

  it("PUT with a non-uuid userId => 403 admin_user_required", async () => {
    h.verify.mockResolvedValue({ isAdmin: true, userId: "admin-1" })
    const r = await PUT(put(settings({ enabled: true })))
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: "admin_user_required" })
    expect(writes()).toEqual([])
  })

  it("PUT with minAgeMinutes 5 => 400, nothing written", async () => {
    const r = await PUT(put(settings({ minAgeMinutes: 5 })))
    expect(r.status).toBe(400)
    expect((await r.json()).error).toMatch(/minAgeMinutes/)
    expect(writes()).toEqual([])
  })

  it("PUT with a non-JSON body => 400, nothing written", async () => {
    const r = await PUT(put("{not json"))
    expect(r.status).toBe(400)
    expect(writes()).toEqual([])
  })

  it("PUT valid => admin_settings upserted, log row with old and new values", async () => {
    const old = settings({ enabled: false, perRun: 10 })
    db.tables.admin_settings.push({ key: AUTO_FULFIL_SETTINGS_KEY, value: old })
    const next = settings({ enabled: true, perRun: 30, networks: ["MTN", "Telecel"] })
    const r = await PUT(put(next))
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.settings).toEqual(next)
    expect(body.valid).toBe(true)
    expect(body.switches.mtn).toBe(true)
    expect(body.waitingAutoRows).toBe(1)

    const up = db.calls.find((c) => c.kind === "upsert")!
    expect(up.table).toBe("admin_settings")
    expect(up.values).toMatchObject({ key: AUTO_FULFIL_SETTINGS_KEY, value: next, updated_by: ADMIN })
    expect(typeof up.values!.description).toBe("string")
    expect(typeof up.values!.updated_at).toBe("string")
    expect(db.tables.admin_settings.find((s) => s.key === AUTO_FULFIL_SETTINGS_KEY)!.value).toEqual(next)

    expect(db.tables.auto_fulfil_settings_log).toEqual([expect.objectContaining({ admin_id: ADMIN, old_value: old, new_value: next })])
    // an enabled save leaves waiting auto rows alone
    expect(db.tables.fulfillment_queue.find((q) => q.id === "q1")!.status).toBe("pending")
  })

  it("PUT on a fresh install logs old_value null", async () => {
    const next = settings({ enabled: true })
    expect((await PUT(put(next))).status).toBe(200)
    expect(db.tables.auto_fulfil_settings_log).toEqual([expect.objectContaining({ admin_id: ADMIN, old_value: null, new_value: next })])
  })

  it("PUT enabled:false => waiting auto rows cancelled", async () => {
    const r = await PUT(put(settings({ enabled: false })))
    expect(r.status).toBe(200)
    expect(db.tables.fulfillment_queue.find((q) => q.id === "q1")).toMatchObject({ status: "failed", error_message: NON_SEND_SWITCHED_OFF })
    expect(db.tables.fulfillment_queue.find((q) => q.id === "q2")!.status).toBe("processing")
    expect(db.tables.fulfillment_queue.find((q) => q.id === "q3")!.status).toBe("pending")
    expect((await r.json()).waitingAutoRows).toBe(0)
  })

  it("PUT upsert failure => 500 generic, no log row, nothing cancelled", async () => {
    db.failUpsert = () => ({ message: "permission denied for table secret_y" })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const r = await PUT(put(settings({ enabled: false })))
      expect(r.status).toBe(500)
      expect(JSON.stringify(await r.json())).not.toContain("secret_y")
      expect(db.tables.auto_fulfil_settings_log).toEqual([])
      expect(db.tables.fulfillment_queue.find((q) => q.id === "q1")!.status).toBe("pending")
    } finally {
      err.mockRestore()
    }
  })

  it("PUT enabled:false still cancels waiting rows when the audit log insert fails, and reports 500", async () => {
    db.failInsert = (t) => (t === "auto_fulfil_settings_log" ? { message: "log broke" } : null)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const r = await PUT(put(settings({ enabled: false })))
      expect(r.status).toBe(500)
      expect(db.tables.fulfillment_queue.find((q) => q.id === "q1")!.status).toBe("failed")
    } finally {
      err.mockRestore()
    }
  })
})
