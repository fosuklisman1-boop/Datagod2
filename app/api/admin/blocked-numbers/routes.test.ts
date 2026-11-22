import { describe, it, expect, vi, beforeEach } from "vitest"
import * as XLSX from "xlsx"
import { NextResponse } from "next/server"
import { makeFakeDb, hasCall, callArgs, type Call, type FakeResult } from "@/lib/blocked-numbers/test-db"

const UUID = "123e4567-e89b-12d3-a456-426614174000"
const NOW = new Date("2026-11-16T10:00:00.000Z")

let admin = true
let handler: (table: string, calls: Call[]) => FakeResult = () => ({})
let fake = makeFakeDb((t, c) => handler(t, c))
const recheck = vi.fn(async (_o: unknown) => ({
  checked: 2, allowed: 1, stillBlocked: 1, unchecked: 0, expired: 0, deferred: 0, newlyAllowedIds: [UUID],
}))

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () =>
    admin
      ? { isAdmin: true, userId: "admin-1", userEmail: "a@x.test" }
      : { isAdmin: false, errorResponse: NextResponse.json({ error: "Admin access required" }, { status: 403 }) }
  ),
}))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (t: string) => fake.db.from(t) } }))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({
  getCustomerVerificationSettings: async () => ({ enabled: true, providers: ["agentportalgh", "kuntanii"], block_unverified: false }),
}))
const scheduleNotify = vi.fn(async () => true)
vi.mock("@/lib/blocked-numbers/notify-now", () => ({ scheduleNotifyNow: () => scheduleNotify() }))
vi.mock("@/lib/blocked-numbers/recheck",() => ({ recheckBlockedNumbers: (o: unknown) => recheck(o) }))
vi.mock("@/lib/blocked-numbers/settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/blocked-numbers/settings")>()),
  getBlockedNumbersSettings: async () => ({ enabled: true, customer_sms_enabled: false, retention_days: 30, spike_threshold_per_hour: 25, daily_sms_ceiling: 300 }),
}))

import { GET as listGET } from "@/app/api/admin/blocked-numbers/route"
import { POST as recheckPOST } from "@/app/api/admin/blocked-numbers/recheck/route"
import { POST as updatePOST } from "@/app/api/admin/blocked-numbers/update/route"
import { GET as exportGET } from "@/app/api/admin/blocked-numbers/export/route"

const req = (url: string, body?: unknown) =>
  new Request(url, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) }) as never

beforeEach(() => {
  admin = true
  handler = () => ({})
  fake = makeFakeDb((t, c) => handler(t, c))
  recheck.mockClear()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

describe("non-admin is rejected on every route", () => {
  it("list, recheck, update, export", async () => {
    admin = false
    expect((await listGET(req("http://x/api/admin/blocked-numbers"))).status).toBe(403)
    expect((await recheckPOST(req("http://x/r", { all: true }))).status).toBe(403)
    expect((await updatePOST(req("http://x/u", { id: UUID, action: "reopen" }))).status).toBe(403)
    expect((await exportGET(req("http://x/e?kind=supplier"))).status).toBe(403)
    expect(recheck).not.toHaveBeenCalled()
    expect(fake.log).toHaveLength(0)
  })
})

describe("recheck route", () => {
  it("more than 500 ids is a 400 and never calls the engine", async () => {
    const ids = Array.from({ length: 501 }, () => UUID)
    const res = await recheckPOST(req("http://x/r", { ids }))
    expect(res.status).toBe(400)
    expect(recheck).not.toHaveBeenCalled()
  })

  it("re-opens expired rows on an explicit admin re-check", async () => {
    const res = await recheckPOST(req("http://x/r", { ids: [UUID] }))
    expect(res.status).toBe(200)
    expect(recheck).toHaveBeenCalledWith({ ids: [UUID], reopenExpired: true })
    const j = await res.json()
    expect(j).toMatchObject({ checked: 2, allowed: 1, stillBlocked: 1 })
    expect(JSON.stringify(j)).not.toContain(UUID) // counts only
  })

  it("a flip schedules notify now; no flip does not; a notify failure never fails the route", async () => {
    scheduleNotify.mockClear()
    const j = await (await recheckPOST(req("http://x/r", { ids: [UUID] }))).json()
    expect(scheduleNotify).toHaveBeenCalledTimes(1)
    expect(j.notifyQueued).toBe(true)

    scheduleNotify.mockClear()
    recheck.mockResolvedValueOnce({ checked: 1, allowed: 0, stillBlocked: 1, unchecked: 0, expired: 0, deferred: 0, newlyAllowedIds: [] })
    const none = await (await recheckPOST(req("http://x/r", { ids: [UUID] }))).json()
    expect(scheduleNotify).not.toHaveBeenCalled()
    expect(none.notifyQueued).toBeUndefined()

    scheduleNotify.mockRejectedValueOnce(new Error("x"))
    const res = await recheckPOST(req("http://x/r", { ids: [UUID] }))
    expect(res.status).toBe(200)
  })

  it("all:true is passed through with reopenExpired", async () => {
    await recheckPOST(req("http://x/r", { all: true }))
    expect(recheck).toHaveBeenCalledWith({ all: true, reopenExpired: true })
  })
})

describe("update route", () => {
  it("handle without a note or with a 501 char note is a 400, nothing written", async () => {
    expect((await updatePOST(req("http://x/u", { id: UUID, action: "handle" }))).status).toBe(400)
    expect((await updatePOST(req("http://x/u", { id: UUID, action: "handle", note: "x".repeat(501) }))).status).toBe(400)
    expect(fake.log).toHaveLength(0)
  })

  it("handle stamps status, handled_by, note and updated_at, guarded on status", async () => {
    handler = () => ({ data: [{ id: UUID }] })
    const res = await updatePOST(req("http://x/u", { id: UUID, action: "handle", note: "told supplier" }))
    expect(res.status).toBe(200)
    const calls = fake.log[0].calls
    const patch = callArgs(calls, "update")![0] as Record<string, unknown>
    expect(patch).toMatchObject({ status: "handled", handled_by: "admin-1", notes: "told supplier", updated_at: NOW.toISOString(), handled_at: NOW.toISOString() })
    expect(hasCall(calls, "eq", "id", UUID)).toBe(true)
    expect(hasCall(calls, "in", "status", ["blocked", "expired"])).toBe(true)
  })

  it("reopen sets status blocked and next_recheck_at now, with a fresh expiry", async () => {
    handler = () => ({ data: [{ id: UUID }] })
    const res = await updatePOST(req("http://x/u", { id: UUID, action: "reopen" }))
    expect(res.status).toBe(200)
    const patch = callArgs(fake.log[0].calls, "update")![0] as Record<string, unknown>
    expect(patch).toMatchObject({ status: "blocked", next_recheck_at: NOW.toISOString(), updated_at: NOW.toISOString() })
    expect(patch.expires_at).toBe(new Date(NOW.getTime() + 30 * 86_400_000).toISOString())
  })

  it("404 when no row matched", async () => {
    handler = () => ({ data: [] })
    expect((await updatePOST(req("http://x/u", { id: UUID, action: "reopen" }))).status).toBe(404)
  })
})

describe("export route", () => {
  const rows = [
    { id: "r1", phone: "0241234567" },
    { id: "r2", phone: "0551234567" },
  ]

  it("report export: Customer texted is blank when no SMS went to the row (notify phone null)", async () => {
    handler = (t) =>
      t === "mtn_blocked_numbers"
        ? {
            data: [
              { id: "r1", phone: "0241234567", status: "allowed", customer_notified_at: "2026-11-15T01:00:00.000Z", customer_notify_phone: null },
              { id: "r2", phone: "0551234567", status: "allowed", customer_notified_at: "2026-11-15T02:00:00.000Z", customer_notify_phone: "0551234567" },
            ],
          }
        : {}
    const res = await exportGET(req("http://x/e?kind=report"))
    expect(res.status).toBe(200)
    const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: "array" })
    const sheet = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]])
    expect(sheet.find((r) => r.Phone === "0241234567")?.["Customer texted"]).toBeUndefined()
    expect(sheet.find((r) => r.Phone === "0551234567")?.["Customer texted"]).toBe("2026-11-15T02:00:00.000Z")
  })

  it("supplier export: single Phone column, only status=blocked, 0XXXXXXXXX", async () => {
    handler = (t) => (t === "mtn_blocked_numbers" ? { data: rows } : {})
    const res = await exportGET(req("http://x/e?kind=supplier&supplier=kuntanii"))
    expect(res.status).toBe(200)
    const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: "array" })
    const sheet = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]])
    expect(sheet).toEqual([{ Phone: "0241234567" }, { Phone: "0551234567" }])
    const selectCalls = fake.log.find((l) => l.table === "mtn_blocked_numbers")!.calls
    expect(hasCall(selectCalls, "eq", "status", "blocked")).toBe(true)
    // no mark requested: nothing stamped
    expect(fake.log.some((l) => l.calls.some(([m]) => m === "update"))).toBe(false)
  })

  it("mark=1 stamps exactly those rows and audits with counts only", async () => {
    handler = (t, calls) => {
      if (t === "mtn_blocked_numbers" && calls.some(([m]) => m === "update")) return { data: [{ id: "r1" }, { id: "r2" }] }
      if (t === "mtn_blocked_numbers") return { data: rows }
      return {}
    }
    const res = await exportGET(req("http://x/e?kind=supplier&supplier=kuntanii&mark=1"))
    expect(res.status).toBe(200)
    expect(res.headers.get("X-Marked-Count")).toBe("2")
    const upd = fake.log.find((l) => l.calls.some(([m]) => m === "update"))!
    expect(callArgs(upd.calls, "update")![0]).toMatchObject({
      submitted_to_supplier: "kuntanii",
      submitted_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    })
    expect(hasCall(upd.calls, "in", "id", ["r1", "r2"])).toBe(true)
    expect(hasCall(upd.calls, "eq", "status", "blocked")).toBe(true)
    const audit = fake.log.find((l) => l.table === "admin_audit_log")!
    const row = (callArgs(audit.calls, "insert")![0] as Array<Record<string, unknown>>)[0]
    expect(row.action).toBe("export_blocked_numbers")
    expect(row.admin_id).toBe("admin-1")
    expect(JSON.stringify(row)).not.toMatch(/\d{9,}/)
  })

  const bigSet = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `id${i}`, phone: `024${String(1000000 + i).slice(-7)}` }))
  const pagedHandler = (all: Array<{ id: string; phone: string }>) => (t: string, calls: Call[]) => {
    if (t !== "mtn_blocked_numbers") return {}
    if (calls.some(([m]) => m === "update")) {
      const ids = (callArgs(calls, "in") as [string, string[]])[1]
      return { data: ids.map((id) => ({ id })) }
    }
    const [a, z] = callArgs(calls, "range") as [number, number]
    return { data: all.slice(a, z + 1) }
  }

  it("2,500 blocked rows: three range reads and 2,500 phones, all marked", async () => {
    handler = pagedHandler(bigSet(2500))
    const res = await exportGET(req("http://x/e?kind=supplier&supplier=kuntanii&mark=1"))
    const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: "array" })
    expect(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]])).toHaveLength(2500)
    const reads = fake.log.filter((l) => l.table === "mtn_blocked_numbers" && l.calls.some(([m]) => m === "range"))
    expect(reads.map((l) => callArgs(l.calls, "range"))).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
    expect(res.headers.get("X-Marked-Count")).toBe("2500")
    expect(res.headers.get("X-Truncated")).toBeNull()
  })

  it("unsubmitted=1 excludes rows already submitted", async () => {
    handler = pagedHandler(bigSet(3))
    await exportGET(req("http://x/e?kind=supplier&unsubmitted=1"))
    const read = fake.log.find((l) => l.calls.some(([m]) => m === "range"))!
    expect(hasCall(read.calls, "is", "submitted_to_supplier", null)).toBe(true)
    await exportGET(req("http://x/e?kind=supplier"))
    const read2 = fake.log.filter((l) => l.calls.some(([m]) => m === "range"))[1]
    expect(read2.calls.some(([m]) => m === "is")).toBe(false)
  })

  it("a row with an un-normalizable phone is neither exported nor marked", async () => {
    handler = pagedHandler([{ id: "good", phone: "0241234567" }, { id: "bad", phone: "not-a-phone" }])
    const res = await exportGET(req("http://x/e?kind=supplier&supplier=kuntanii&mark=1"))
    const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: "array" })
    expect(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]])).toEqual([{ Phone: "0241234567" }])
    const upd = fake.log.find((l) => l.calls.some(([m]) => m === "update"))!
    expect(hasCall(upd.calls, "in", "id", ["good"])).toBe(true)
    expect(res.headers.get("X-Marked-Count")).toBe("1")
  })

  it("hitting the 10,000 cap sets X-Truncated", async () => {
    handler = pagedHandler(bigSet(10_500))
    const res = await exportGET(req("http://x/e?kind=supplier"))
    expect(res.headers.get("X-Truncated")).toBe("1")
    expect(res.headers.get("X-Number-Count")).toBe("10000")
  })

  it("a supplier outside the checkout provider list is a 400", async () => {
    expect((await exportGET(req("http://x/e?kind=supplier&supplier=evilcorp"))).status).toBe(400)
    expect((await exportGET(req("http://x/e?kind=supplier&mark=1"))).status).toBe(400)
    expect(fake.log).toHaveLength(0)
  })

  it("unknown kind is a 400", async () => {
    expect((await exportGET(req("http://x/e?kind=everything"))).status).toBe(400)
  })
})

describe("list route", () => {
  it("returns paged rows with surfaces and shop names, and stats on request", async () => {
    handler = (t, calls) => {
      if (t === "mtn_blocked_numbers" && hasCall(calls, "select", "id", { count: "exact", head: true })) return { count: 7 }
      if (t === "mtn_blocked_numbers")
        return {
          data: [{ id: "n1", phone: "0241234567", status: "blocked", last_surface: "storefront", last_shop_id: "s1", attempts: 3 }],
          count: 1,
        }
      if (t === "mtn_blocked_attempts") return { data: [{ blocked_number_id: "n1", surface: "api_v1", shop_id: null }], count: 4 }
      if (t === "user_shops") return { data: [{ id: "s1", shop_name: "Alpha" }] }
      return {}
    }
    const res = await listGET(req("http://x/api/admin/blocked-numbers?include_stats=1"))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.total).toBe(1)
    expect(j.pageSize).toBe(50)
    expect(j.rows[0]).toMatchObject({ phone: "0241234567", surfaces: ["storefront", "api_v1"], shopNames: ["Alpha"] })
    expect(j.stats).toBeTruthy()
  })

  it("customersTexted7d counts only rows that have a notify phone (nobody was texted otherwise)", async () => {
    handler = (t) => (t === "mtn_blocked_numbers" ? { count: 3, data: [] } : {})
    const res = await listGET(req("http://x/api/admin/blocked-numbers?include_stats=1"))
    expect(res.status).toBe(200)
    const texted = fake.log
      .filter((l) => l.table === "mtn_blocked_numbers")
      .find((l) => l.calls.some(([m, a]) => m === "gte" && a[0] === "customer_notified_at"))
    expect(texted).toBeTruthy()
    expect(hasCall(texted!.calls, "not", "customer_notify_phone", "is", null)).toBe(true)
  })
})
