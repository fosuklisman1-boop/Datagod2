import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { makeFakeDb, type FakeCall, type FakeResult } from "../../support/_fake-db"

const h = vi.hoisted(() => ({ client: null as any, auth: null as any }))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => h.client[k] }) }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => h.auth) }))

import { GET } from "./route"

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const ORDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

let fake: ReturnType<typeof makeFakeDb>

function install(complaints: any[], extra: (c: FakeCall) => FakeResult | undefined = () => undefined) {
  fake = makeFakeDb((c) => {
    const o = extra(c)
    if (o) return o
    if (c.table === "complaints") return { data: complaints }
    if (c.table === "users") return { data: [{ id: USER, first_name: "Ama", last_name: "K", email: "a@x.com", phone_number: "0240000000" }] }
    if (c.table === "orders") {
      return { data: [{ id: ORDER, network: "MTN", size: 2, price: 10, status: "completed", phone_number: "0241111111", order_code: "ORD-1", created_at: "2026-11-01T00:00:00Z" }] }
    }
    if (c.table === "mtn_fulfillment_tracking") return { data: [{ provider: "kuntanii", created_at: "2026-11-01T00:00:00Z", order_id: ORDER, shop_order_id: null }] }
    return undefined
  })
  h.client = fake.db
}

const baseRow = {
  user_id: USER, title: "t", description: "d", category: "data", status: "pending", priority: "normal",
  resolution_notes: null, created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00",
}

const get = (qs = "") => GET(new NextRequest(`http://localhost/api/admin/complaints${qs}`))

beforeEach(() => {
  vi.clearAllMocks()
  h.auth = { isAdmin: true, userId: ADMIN }
  install([])
})

describe("GET /api/admin/complaints", () => {
  it("refuses a non-admin before touching the database", async () => {
    h.auth = { isAdmin: false, errorResponse: NextResponse.json({ error: "Admin access required" }, { status: 403 }) }
    expect((await get()).status).toBe(403)
    expect(fake.calls).toHaveLength(0)
  })

  it("401 for the cron-secret caller without a user id", async () => {
    h.auth = { isAdmin: true }
    expect((await get()).status).toBe(401)
    expect(fake.calls).toHaveLength(0)
  })

  it("runs one query for open rows regardless of age and one for rows inside the clamped window, each limited to 500", async () => {
    await get("?days=9999")
    const qs = fake.calls.filter((c) => c.table === "complaints")
    expect(qs).toHaveLength(2)
    const open = qs.find((c) => c.filters.some(([k]) => k === "status:in"))!
    expect(open.filters.find(([k]) => k === "status:in")?.[1]).toEqual(["pending", "in_review"])
    expect(open.filters.some(([k]) => k === "created_at:gte")).toBe(false)
    const windowed = qs.find((c) => c.filters.some(([k]) => k === "created_at:gte"))!
    const since = String(windowed.filters.find(([k]) => k === "created_at:gte")![1])
    const days = (Date.now() - Date.parse(since)) / 86_400_000
    expect(days).toBeGreaterThan(89.9)
    expect(days).toBeLessThan(90.1)
    for (const q of qs) {
      expect(q.limitN).toBe(500)
      expect(q.orders).toEqual([["created_at", { ascending: false }]])
    }
  })

  it("returns an old pending row even when the windowed query alone fills its limit, newest first", async () => {
    const filler = Array.from({ length: 500 }, (_, i) => ({
      ...baseRow, id: `w${i}`, order_id: null, evidence: null, order_details: null, status: "resolved",
      created_at: new Date(Date.UTC(2026, 10, 1) - i * 1000).toISOString(),
    }))
    const oldPending = { ...baseRow, id: "old-pending", order_id: null, evidence: null, order_details: null, created_at: "2026-01-01T00:00:00.000Z" }
    install([], (c) => {
      if (c.table !== "complaints") return undefined
      return c.filters.some(([k]) => k === "status:in") ? { data: [oldPending] } : { data: filler }
    })
    const ids = (await (await get("?days=7")).json()).data.complaints.map((r: any) => r.id)
    expect(ids).toHaveLength(501)
    expect(ids).toContain("old-pending")
    expect(ids[0]).toBe("w0")
    expect(ids[ids.length - 1]).toBe("old-pending")
  })

  it("lists a row once when both queries return it", async () => {
    install([{ ...baseRow, id: "dup", order_id: null, evidence: null, order_details: null }])
    const ids = (await (await get()).json()).data.complaints.map((r: any) => r.id)
    expect(ids).toEqual(["dup"])
  })

  it("returns a pending row older than the window", async () => {
    install([{ ...baseRow, id: "c1", order_id: null, evidence: null, order_details: null }])
    const body = await (await get("?days=1")).json()
    expect(body.success).toBe(true)
    expect(body.data.complaints.map((c: any) => c.id)).toEqual(["c1"])
  })

  it("joins user, order and supplier when order_id is set", async () => {
    install([{ ...baseRow, id: "c2", order_id: ORDER, evidence: null, order_details: null }])
    const [row] = (await (await get()).json()).data.complaints
    expect(row.user).toMatchObject({ first_name: "Ama", email: "a@x.com" })
    expect(row.order).toMatchObject({ source: "order", id: ORDER, reference: "ORD-1", size: "2GB" })
    expect(row.supplier).toMatchObject({ kind: "supplier", provider: "kuntanii" })
  })

  it("builds the order from order_details for a shop row with no order_id, and supplier is null", async () => {
    install([{
      ...baseRow, id: "c3", order_id: null, evidence: null,
      order_details: { type: "shop", orderRefId: "SHOP-9", network: "AirtelTigo", package: "5", phone: "0242222222", amount: 20, date: "2026-10-01" },
    }])
    const [row] = (await (await get()).json()).data.complaints
    expect(row.order).toMatchObject({ reference: "SHOP-9", beneficiary: "0242222222", network: "AirtelTigo", size: "5GB", price: 20 })
    expect(row.supplier).toBeNull()
    expect(fake.calls.some((c) => c.table === "orders")).toBe(false)
  })

  it("never returns stale signed URLs; returns evidence paths and has_evidence", async () => {
    install([
      { ...baseRow, id: "c4", order_id: null, order_details: null,
        evidence: { balance_image_path: "u/b.jpg", momo_receipt_path: "", balance_image_url: "https://stale/x?token=1" } },
      { ...baseRow, id: "c5", order_id: null, order_details: null, evidence: { momo_receipt_url: "https://stale/y" } },
    ])
    const rows = (await (await get()).json()).data.complaints
    expect(rows[0].has_evidence).toBe(true)
    expect(rows[0].evidence_paths).toEqual({ balance_image_path: "u/b.jpg", momo_receipt_path: null })
    expect(rows[1].has_evidence).toBe(false)
    expect(JSON.stringify(rows)).not.toContain("stale")
    expect(rows[0]).not.toHaveProperty("evidence")
  })

  it("500 with a generic message when the query fails", async () => {
    install([], (c) => (c.table === "complaints" ? { error: { message: "boom secret" } } : undefined))
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret")
  })
})
