import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { makeFakeDb, type FakeDb } from "@/lib/order-queue/fake-db.test-helper"

const verifyMock = vi.fn()
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: (...a: unknown[]) => verifyMock(...a) }))

const current = vi.hoisted(() => ({ db: null as any }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => current.db.from(t) }) }))

import { POST } from "./route"

// Readable names -> stable uuids (order ids are uuids). The suffix uses only the letters a-f, so no
// id contains a run of digits that the "no phone-like digits in logs" check below would flag.
const registry = new Map<string, string>()
function U(name: string): string {
  let id = registry.get(name)
  if (!id) {
    let n = registry.size
    let suffix = ""
    for (let i = 0; i < 12; i++) {
      suffix = "abcdef"[n % 6] + suffix
      n = Math.floor(n / 6)
    }
    id = `cafebabe-dead-4bee-afad-${suffix}`
    registry.set(name, id)
  }
  return id
}

const ADMIN = "5d3a0c1e-aaaa-bbbb-cccc-dddddddddddd"
const post = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/fulfillment/enqueue", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
  })
const o = (name: string, type = "bulk") => ({ id: U(name), type })

const PHONE = "0241234567"
const bulk = (name: string, status: string, network = "MTN") => ({ id: U(name), status, network, phone_number: PHONE, size: 1 })
const trk = (id: string, orderName: string, status: string, mtnOrderId: string, created = "2026-11-21T10:00:00Z") => ({
  id,
  order_id: U(orderName),
  shop_order_id: null,
  api_order_id: null,
  status,
  mtn_order_id: mtnOrderId,
  created_at: created,
  recipient_phone: PHONE,
})

let db: FakeDb
let logs: string[]
const spies: any[] = []

beforeEach(() => {
  vi.clearAllMocks()
  verifyMock.mockResolvedValue({ isAdmin: true, userId: ADMIN })
  db = makeFakeDb({
    orders: [
      bulk("ok-1", "pending"),
      bulk("ok-2", "pending"),
      bulk("done-1", "completed"),
      bulk("live-1", "processing"),
      bulk("held-1", "processing"),
      bulk("rev-1", "reversed"),
      bulk("fail-1", "failed"),
      bulk("tel-1", "pending", "telecel"),
      bulk("atg-1", "pending", "AirtelTigo"),
      bulk("q-1", "pending"),
    ],
    shop_orders: [{ id: U("shop-held"), order_status: "processing", network: "MTN", payment_status: "completed", customer_phone: PHONE }],
    mtn_fulfillment_tracking: [
      trk("t1", "live-1", "processing", "ext-live"),
      trk("t2", "held-1", "abandoned", "UNKNOWN_77"),
      trk("t3", "rev-1", "reversed", "ext-rev"),
      { ...trk("t4", "x", "abandoned", "UNKNOWN_78"), order_id: null, shop_order_id: U("shop-held") },
    ],
    fulfillment_queue: [{ id: "fq-1", order_id: U("q-1"), order_type: "bulk", status: "pending" }],
    admin_bulk_send_log: [],
  })
  current.db = db
  // Fixed batch id so the "no 9+ digit run in logs" check below is deterministic (a random uuid can contain one).
  spies.push(vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("b0a0c0d0-aaaa-bbbb-cccc-eeeeeeeeeeee"))
  logs = []
  for (const k of ["log", "warn", "error", "info"] as const) {
    spies.push(vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))))
  }
})
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
  // No captured log line may carry a phone-number-like run of digits.
  for (const l of logs) expect(l).not.toMatch(/\d{9,}/)
})

const queueInserts = () => db.calls.filter((c) => c.table === "fulfillment_queue" && c.kind === "insert")
const orderUpdates = () => db.calls.filter((c) => c.kind === "update" && c.table !== "fulfillment_queue")
const sendLogs = () => db.calls.filter((c) => c.table === "admin_bulk_send_log" && c.kind === "insert")
const reasonOf = (body: any, name: string) => body.rejected.find((r: any) => r.id === U(name))?.reason
const statusOf = (name: string) => db.tables.orders.find((r) => r.id === U(name))!.status
const sorted = (xs: string[]) => [...xs].sort()
const ids = (...names: string[]) => names.map(U)

describe("POST /api/admin/fulfillment/enqueue — request checks", () => {
  it("passes the auth error through for non-admins", async () => {
    verifyMock.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "nope" }, { status: 403 }) })
    const res = await POST(post({ orders: [o("ok-1")], provider: "sykes" }))
    expect(res.status).toBe(403)
    expect(db.calls).toHaveLength(0)
  })

  it("honours the rate-limit response even for admins", async () => {
    verifyMock.mockResolvedValue({ isAdmin: true, userId: ADMIN, errorResponse: NextResponse.json({ error: "slow" }, { status: 429 }) })
    const res = await POST(post({ orders: [o("ok-1")], provider: "sykes" }))
    expect(res.status).toBe(429)
    expect(db.calls).toHaveLength(0)
  })

  it("refuses a caller with no admin user id (bulk sends must be attributable)", async () => {
    verifyMock.mockResolvedValue({ isAdmin: true })
    const res = await POST(post({ orders: [o("ok-1")], provider: "sykes" }))
    expect(res.status).toBe(403)
    expect(db.calls).toHaveLength(0)
  })

  it("400 for an empty list", async () => {
    const res = await POST(post({ orders: [], provider: "sykes" }))
    expect(res.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it("400 for 201 orders, nothing read or written", async () => {
    const orders = Array.from({ length: 201 }, (_, i) => o(`o${i}`))
    const res = await POST(post({ orders, provider: "sykes" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/200/)
    expect(db.calls).toHaveLength(0)
  })

  it("400 for 201 orders in auto mode too", async () => {
    const orders = Array.from({ length: 201 }, (_, i) => o(`o${i}`))
    expect((await POST(post({ orders }))).status).toBe(400)
  })

  it("400 for an unknown provider", async () => {
    for (const provider of ["acme", "", 5, "SYKES"]) {
      const res = await POST(post({ orders: [o("ok-1")], provider }))
      expect(res.status).toBe(400)
    }
    expect(db.calls).toHaveLength(0)
  })

  it("400 for a malformed order entry or bad JSON", async () => {
    expect((await POST(post({ orders: [o("ok-1", "airtime")], provider: "sykes" }))).status).toBe(400)
    expect((await POST(post({ orders: [o("ok-1")], provider: "sykes", riskyAck: { count: "2" } }))).status).toBe(400)
    expect((await POST(post("{not json"))).status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it("400 invalid_order_id for any non-uuid id (whole request, nothing read or written)", async () => {
    const bad = [
      "",
      "ok-1",
      "12345",
      `${U("ok-1")} `,
      `${U("ok-1")}"`,
      `${U("ok-1")},${U("ok-2")}`,
      `"${U("ok-1")}"`,
      'a"),status.eq.(pending',
      U("ok-1").replace(/-/g, ""),
      5,
      null,
    ]
    for (const id of bad) {
      const res = await POST(post({ orders: [o("ok-2"), { id, type: "bulk" }], provider: "sykes" }))
      expect(res.status, String(id)).toBe(400)
      expect(await res.json()).toEqual({ error: "invalid_order_id" })
    }
    expect(db.calls).toHaveLength(0)
  })

  it("accepts an upper-case uuid and matches it to the stored (lower-case) id", async () => {
    const body = await (await POST(post({ orders: [{ id: U("ok-1").toUpperCase(), type: "bulk" }], provider: "sykes" }))).json()
    expect(body.queued).toEqual(ids("ok-1"))
  })
})

describe("POST /api/admin/fulfillment/enqueue — server-checked send", () => {
  it("mixed batch: only eligible ids are queued and every rejection carries its reason", async () => {
    const res = await POST(
      post({
        provider: "sykes",
        orders: [o("ok-1"), o("done-1"), o("live-1"), o("fail-1"), o("tel-1"), o("q-1"), o("ghost"), o("ok-1")],
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.queued).toEqual(ids("ok-1"))
    expect(typeof body.batchId).toBe("string")
    expect(reasonOf(body, "done-1")).toBe("completed")
    expect(reasonOf(body, "live-1")).toBe("live_at_supplier")
    expect(reasonOf(body, "fail-1")).toBe("not_pending")
    expect(reasonOf(body, "tel-1")).toBe("supplier_cannot_serve_network") // sykes is MTN-only
    expect(reasonOf(body, "q-1")).toBe("already_queued")
    expect(reasonOf(body, "ghost")).toBe("not_found")
    expect(body.rejected.filter((r: any) => r.id === U("ok-1"))).toEqual([{ id: U("ok-1"), reason: "duplicate_in_request" }])
    for (const r of body.rejected) expect(Object.keys(r).sort()).toEqual(["id", "reason"])
    expect(queueInserts().map((c) => c.values)).toEqual([{ batch_id: body.batchId, order_id: U("ok-1"), order_type: "bulk", provider: "sykes" }])
    expect(orderUpdates()).toHaveLength(0)
  })

  it("an explicit supplier is refused for a network outside MTN/Telecel/AT-iShare/AT-BigTime (no silent re-route)", async () => {
    const body = await (await POST(post({ provider: "xpress", orders: [o("atg-1")] }))).json()
    expect(body.queued).toEqual([])
    expect(reasonOf(body, "atg-1")).toBe("supplier_cannot_serve_network")
  })

  it("risky present without ack: risky rejected needs_confirmation, eligible still queued, no status change", async () => {
    const res = await POST(post({ provider: "sykes", orders: [o("ok-1"), o("held-1"), o("rev-1")] }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.queued).toEqual(ids("ok-1"))
    expect(reasonOf(body, "held-1")).toBe("needs_confirmation")
    expect(reasonOf(body, "rev-1")).toBe("needs_confirmation")
    expect(sorted(body.risky)).toEqual(sorted(ids("held-1", "rev-1")))
    expect(orderUpdates()).toHaveLength(0)
  })

  it("risky with the wrong count: 400 and NOTHING written", async () => {
    const res = await POST(post({ provider: "sykes", riskyAck: { count: 1 }, orders: [o("ok-1"), o("held-1"), o("rev-1")] }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "risky_ack_mismatch", expected: 2 })
    expect(db.calls.filter((c) => c.kind !== "select")).toHaveLength(0)
  })

  it("an ack when the server finds no risky order is also a mismatch (state changed under the admin)", async () => {
    const res = await POST(post({ provider: "sykes", riskyAck: { count: 1 }, orders: [o("ok-1")] }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "risky_ack_mismatch", expected: 0 })
    expect(db.calls.filter((c) => c.kind !== "select")).toHaveLength(0)
  })

  it("risky with the correct ack: each is set to pending guarded on its current status, before its insert", async () => {
    const res = await POST(
      post({ provider: "sykes", riskyAck: { count: 3 }, orders: [o("held-1"), o("rev-1"), o("shop-held", "shop"), o("ok-1")] }),
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(sorted(body.queued)).toEqual(sorted(ids("held-1", "ok-1", "rev-1", "shop-held")))
    expect(body.rejected).toEqual([])
    expect(sorted(body.risky)).toEqual(sorted(ids("held-1", "rev-1", "shop-held")))

    const ups = orderUpdates()
    expect(ups).toHaveLength(3)
    const held = ups.find((u) => u.filters.some((f) => f.val === U("held-1")))!
    expect(held.table).toBe("orders")
    expect(held.values).toEqual({ status: "pending" })
    expect(held.filters).toEqual([
      { op: "eq", col: "id", val: U("held-1") },
      { op: "in", col: "status", val: ["processing"] },
    ])
    const rev = ups.find((u) => u.filters.some((f) => f.val === U("rev-1")))!
    expect(rev.filters).toContainEqual({ op: "in", col: "status", val: ["reversed"] })
    const shop = ups.find((u) => u.filters.some((f) => f.val === U("shop-held")))!
    expect(shop.table).toBe("shop_orders")
    expect(shop.values).toEqual({ order_status: "pending" })
    expect(shop.filters).toContainEqual({ op: "in", col: "order_status", val: ["processing"] })

    for (const id of ids("held-1", "rev-1", "shop-held")) {
      const u = db.calls.findIndex((c) => c.kind === "update" && c.filters.some((f) => f.val === id))
      const i = db.calls.findIndex((c) => c.kind === "insert" && c.table === "fulfillment_queue" && c.values!.order_id === id)
      expect(u).toBeGreaterThanOrEqual(0)
      expect(i).toBeGreaterThan(u)
    }
    expect(statusOf("rev-1")).toBe("pending")
  })

  it("a risky order whose guarded update matches 0 rows is rejected `changed` and not queued", async () => {
    db.beforeUpdate = (_t, _v, filters) => {
      if (filters.some((f) => f.val === U("rev-1"))) db.tables.orders.find((r) => r.id === U("rev-1"))!.status = "completed"
    }
    const body = await (await POST(post({ provider: "sykes", riskyAck: { count: 2 }, orders: [o("held-1"), o("rev-1")] }))).json()
    expect(body.queued).toEqual(ids("held-1"))
    expect(reasonOf(body, "rev-1")).toBe("changed")
    expect(queueInserts().map((c) => c.values!.order_id)).toEqual(ids("held-1"))
  })

  it("a unique violation on insert is reported already_queued; another insert error is insert_failed and the rest continue", async () => {
    db.tables.orders.push(bulk("ok-3", "pending"))
    db.failInsert = (t, row) => {
      if (t !== "fulfillment_queue") return null
      if (row.order_id === U("ok-1")) return { code: "23505", message: "duplicate key" }
      if (row.order_id === U("ok-2")) return { code: "57014", message: "timeout" }
      return null
    }
    const body = await (await POST(post({ provider: "sykes", orders: [o("ok-1"), o("ok-2"), o("ok-3")] }))).json()
    expect(body.queued).toEqual(ids("ok-3"))
    expect(reasonOf(body, "ok-1")).toBe("already_queued")
    expect(reasonOf(body, "ok-2")).toBe("insert_failed")
  })

  it("inserts one row at a time (never a bulk insert / upsert)", async () => {
    await POST(post({ provider: "sykes", orders: [o("ok-1"), o("ok-2")] }))
    expect(queueInserts()).toHaveLength(2)
    for (const c of queueInserts()) expect(Array.isArray(c.values)).toBe(false)
  })

  it("a released risky order that hits already_queued is left pending (another request's live row owns it)", async () => {
    db.failInsert = (t, row) => (t === "fulfillment_queue" && row.order_id === U("rev-1") ? { code: "23505", message: "dup" } : null)
    const body = await (await POST(post({ provider: "sykes", riskyAck: { count: 1 }, orders: [o("rev-1")] }))).json()
    expect(reasonOf(body, "rev-1")).toBe("already_queued")
    expect(orderUpdates()).toHaveLength(1) // the release only, no revert
    expect(statusOf("rev-1")).toBe("pending")
  })

  it("a released risky order whose insert fails for another reason goes back to its old status (guarded)", async () => {
    db.failInsert = (t, row) => (t === "fulfillment_queue" && row.order_id === U("rev-1") ? { code: "57014", message: "timeout" } : null)
    const body = await (await POST(post({ provider: "sykes", riskyAck: { count: 1 }, orders: [o("rev-1")] }))).json()
    expect(reasonOf(body, "rev-1")).toBe("insert_failed")
    expect(statusOf("rev-1")).toBe("reversed")
    const revert = orderUpdates()[1]
    expect(revert.values).toEqual({ status: "reversed" })
    expect(revert.filters).toEqual([
      { op: "eq", col: "id", val: U("rev-1") },
      { op: "eq", col: "status", val: "pending" },
    ])
  })

  it("writes exactly one admin_bulk_send_log row per request, ids and reasons only", async () => {
    const res = await POST(post({ provider: "sykes", riskyAck: { count: 1 }, orders: [o("ok-1"), o("rev-1"), o("done-1")] }))
    const body = await res.json()
    expect(sendLogs()).toHaveLength(1)
    const row = sendLogs()[0].values!
    expect(row).toEqual({
      admin_id: ADMIN,
      supplier: "sykes",
      batch_id: body.batchId,
      accepted_ids: ids("ok-1", "rev-1"),
      rejected: [{ id: U("done-1"), reason: "completed" }],
      risky_ids: ids("rev-1"),
    })
    expect(JSON.stringify(row)).not.toMatch(/\d{9,}/)
  })

  it("a send-log write failure does not undo or hide the queued orders", async () => {
    db.failInsert = (t) => (t === "admin_bulk_send_log" ? { message: "relation does not exist" } : null)
    const res = await POST(post({ provider: "sykes", orders: [o("ok-1")] }))
    expect(res.status).toBe(200)
    expect((await res.json()).queued).toEqual(ids("ok-1"))
  })

  it("500 and nothing written when the order snapshots cannot be read", async () => {
    db.failSelect = (t) => (t === "mtn_fulfillment_tracking" ? { message: "boom" } : null)
    const res = await POST(post({ provider: "sykes", orders: [o("ok-1")] }))
    expect(res.status).toBe(500)
    expect(db.calls.filter((c) => c.kind !== "select")).toHaveLength(0)
  })

  it("explicit non-MTN supplier for a Telecel order is queued", async () => {
    const body = await (await POST(post({ provider: "xpress", orders: [o("tel-1")] }))).json()
    expect(body.queued).toEqual(ids("tel-1"))
  })
})

describe("POST /api/admin/fulfillment/enqueue — legacy auto-routing (no provider)", () => {
  it("queues eligible orders of any network with provider null and applies every other rule", async () => {
    const body = await (await POST(post({ orders: [o("ok-1"), o("tel-1"), o("live-1"), o("done-1"), o("held-1"), o("q-1")] }))).json()
    expect(body.queued).toEqual(ids("ok-1", "tel-1"))
    expect(reasonOf(body, "live-1")).toBe("live_at_supplier")
    expect(reasonOf(body, "done-1")).toBe("completed")
    expect(reasonOf(body, "held-1")).toBe("needs_confirmation")
    expect(reasonOf(body, "q-1")).toBe("already_queued")
    expect(queueInserts().map((c) => c.values!.provider)).toEqual([null, null])
    expect(sendLogs()).toHaveLength(1)
    expect(sendLogs()[0].values!.supplier).toBe("auto")
  })

  it("a riskyAck with no supplier is refused: 400 risky_requires_supplier, nothing read or written", async () => {
    for (const provider of [undefined, null]) {
      const res = await POST(post({ provider, riskyAck: { count: 1 }, orders: [o("ok-1"), o("rev-1")] }))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "risky_requires_supplier" })
    }
    expect(db.calls).toHaveLength(0)
    expect(statusOf("rev-1")).toBe("reversed")
  })

  it("auto mode never releases a risky order: held/reversed are needs_confirmation, never set to pending", async () => {
    const body = await (await POST(post({ orders: [o("ok-1"), o("held-1"), o("rev-1"), o("shop-held", "shop")] }))).json()
    expect(body.queued).toEqual(ids("ok-1"))
    for (const n of ["held-1", "rev-1", "shop-held"]) expect(reasonOf(body, n)).toBe("needs_confirmation")
    expect(orderUpdates()).toHaveLength(0)
    expect(queueInserts().map((c) => c.values!.order_id)).toEqual(ids("ok-1"))
  })
})
