import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { ORDERS_ENTRIES } from "./orders"
import { CATALOG } from "../index"
import { EXCLUDED } from "../excluded"
import { PENDING } from "../pending"
import { ADMIN_PAGES, pageTitleFor } from "../pages"
import type { Risk } from "../types"

const key = (method: string, path: string) => `${method} ${path}`

const CATALOGUED = [
  "GET /api/admin/batches/cleanup",
  "GET /api/admin/order-history",
  "GET /api/admin/orders/all",
  "GET /api/admin/orders/all-pending",
  "GET /api/admin/orders/batches",
  "GET /api/admin/orders/pending",
  "GET /api/admin/orders/pending-count",
  "GET /api/admin/orders/queue",
  "GET /api/admin/payment-attempts",
  "GET /api/admin/payment-reverify",
  "GET /api/admin/shop-orders/pending",
  "GET /api/admin/transactions",
  "PATCH /api/admin/payment-attempts",
  "POST /api/admin/afa-update-status",
  "POST /api/admin/batches/cleanup",
  "POST /api/admin/orders/batch-statuses",
  "POST /api/admin/orders/bulk-update-status",
  "POST /api/admin/orders/delete-batches",
  "POST /api/admin/orders/trigger-xpress-cron",
  "POST /api/admin/payment-reverify",
  "POST /api/admin/shop-orders/update-status",
  "POST /api/admin/sync-orders",
]

const EXCLUDED_ROUTES = [
  "POST /api/admin/orders/recover-xpress-reversals",
  "POST /api/admin/stale-tracking/recheck",
]

const byKey = (k: string) => ORDERS_ENTRIES.find((e) => key(e.method, e.path) === k)!

describe("orders catalog coverage", () => {
  it("catalogues exactly the listed routes and registers them in CATALOG", () => {
    expect(ORDERS_ENTRIES.map((e) => key(e.method, e.path)).sort()).toEqual([...CATALOGUED].sort())
    for (const k of CATALOGUED) {
      expect(PENDING, k).not.toContain(k)
      expect(CATALOG.map((e) => key(e.method, e.path)), k).toContain(k)
    }
  })

  it("moves the two long-running routes to EXCLUDED with a reason", () => {
    for (const k of EXCLUDED_ROUTES) {
      expect(PENDING, k).not.toContain(k)
      const row = EXCLUDED.find((e) => key(e.method, e.path) === k)
      expect(row, k).toBeTruthy()
      expect(row!.reason).toMatch(/use the page/)
    }
  })

  it("ids are unique and area is orders", () => {
    const ids = ORDERS_ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of ORDERS_ENTRIES) expect(e.area).toBe("orders")
  })
})

describe("orders catalog rules", () => {
  it("pages are exact ADMIN_PAGES paths with matching titles", () => {
    const paths = new Set(ADMIN_PAGES.map((p) => p.path))
    for (const e of ORDERS_ENTRIES) {
      expect(paths.has(e.page), e.id).toBe(true)
      expect(e.pageTitle, e.id).toBe(pageTitleFor(e.page))
    }
  })

  it("every schema is strict and rejects an unknown key", () => {
    for (const e of ORDERS_ENTRIES) {
      for (const schema of [e.query, e.body].filter(Boolean)) {
        const r = schema!.safeParse({ __unknown_key__: 1 })
        expect(r.success, e.id).toBe(false)
        if (!r.success) expect(r.error.issues.some((i) => i.code === "unrecognized_keys"), e.id).toBe(true)
      }
    }
  })

  it("declares a param for every :name segment", () => {
    for (const e of ORDERS_ENTRIES) {
      const inPath = e.path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1)).sort()
      expect(Object.keys(e.params ?? {}).sort(), e.id).toEqual(inPath)
    }
  })

  it("lookups have resultKeep, writes are changes", () => {
    for (const e of ORDERS_ENTRIES) {
      if (e.kind === "lookup") {
        expect(e.method, e.id).toBe("GET")
        expect(e.resultKeep?.length, e.id).toBeGreaterThan(0)
      }
      if (e.method !== "GET") expect(e.kind, e.id).toBe("change")
    }
  })

  it("side-effect GETs are changes", () => {
    expect(byKey("GET /api/admin/batches/cleanup").kind).toBe("change")
    expect(byKey("GET /api/admin/payment-attempts").kind).toBe("change")
  })

  it("lookups never keep contact details or secrets", () => {
    for (const e of ORDERS_ENTRIES) {
      for (const p of e.resultKeep ?? []) {
        expect(p, e.id).not.toMatch(/phone|email|token|secret|password|api_key|payload/i)
      }
    }
  })

  it("risk tiers are at least the table's", () => {
    const rank: Record<Risk, number> = { normal: 0, money: 1, danger: 2 }
    const min: Record<string, Risk> = {
      "POST /api/admin/orders/bulk-update-status": "money",
      "POST /api/admin/shop-orders/update-status": "money",
      "POST /api/admin/payment-reverify": "money",
      "PATCH /api/admin/payment-attempts": "money",
      "POST /api/admin/afa-update-status": "money",
      "POST /api/admin/sync-orders": "money",
      "POST /api/admin/orders/trigger-xpress-cron": "money",
      "POST /api/admin/orders/delete-batches": "danger",
      "POST /api/admin/batches/cleanup": "danger",
      "GET /api/admin/batches/cleanup": "danger",
    }
    for (const [k, r] of Object.entries(min)) expect(rank[byKey(k).risk], k).toBeGreaterThanOrEqual(rank[r])
  })

  it("bulk status uses the typed tool", () => {
    expect(byKey("POST /api/admin/orders/bulk-update-status").typedCard).toBe("prepare_bulk_status_update")
  })

  it("auth is admin for every route", () => {
    for (const e of ORDERS_ENTRIES) expect(e.auth, e.id).toBe("admin")
  })

  it("provider-calling loops have a capped timeout", () => {
    for (const k of ["POST /api/admin/sync-orders", "POST /api/admin/payment-reverify", "GET /api/admin/order-history"]) {
      const t = byKey(k).timeoutMs
      expect(t, k).toBeGreaterThan(15000)
      expect(t, k).toBeLessThanOrEqual(60000)
    }
  })
})

// ---- card tests with a tiny fake db ----------------------------------------------------------------------------

type Row = Record<string, unknown>

function fakeDb(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? []
      const filters: Array<(r: Row) => boolean> = []
      const b: any = {
        select() { return b },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b },
        in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b },
        lt(c: string, v: string) { filters.push((r) => String(r[c]) < v); return b },
        gte(c: string, v: string) { filters.push((r) => String(r[c]) >= v); return b },
        lte(c: string, v: string) { filters.push((r) => String(r[c]) <= v); return b },
        limit() { return b },
        order() { return b },
        maybeSingle() { const d = rows.filter((r) => filters.every((f) => f(r))); return Promise.resolve({ data: d[0] ?? null, error: null }) },
        single() { const d = rows.filter((r) => filters.every((f) => f(r))); return Promise.resolve({ data: d[0] ?? null, error: d.length ? null : { message: "none" } }) },
        then(res: any, rej: any) {
          const d = rows.filter((r) => filters.every((f) => f(r)))
          return Promise.resolve({ data: d, count: d.length, error: null }).then(res, rej)
        },
      }
      return b
    },
  } as unknown as SupabaseClient
}

const brokenDb = { from() { throw new Error("db down") } } as unknown as SupabaseClient

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001"
const U2 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002"
const ADMIN = "11111111-1111-4111-8111-111111111111"

const tables = {
  shop_orders: [
    { id: U1, order_status: "pending", payment_status: "pending", reference_code: "ORD-1", total_price: 12.5, network: "MTN", customer_email: "leak@example.com", api_key: "SECRET123" },
    { id: U2, order_status: "processing", payment_status: "completed", reference_code: "ORD-2", total_price: 5, network: "MTN", customer_email: "leak@example.com", api_key: "SECRET123" },
  ],
  airtime_orders: [{ id: U1, reference_code: "AT-1", total_paid: 3, payment_status: "pending", status: "pending" }],
  payment_attempts: [
    { id: U1, reference: "WALLET-1", amount: 40, status: "pending", payment_type: "wallet_topup", email: "leak@example.com", paystack_secret: "SECRET123" },
  ],
  afa_orders: [{ id: U1, status: "pending", full_name: "Ama Mensah", phone_number: "0241234567", order_code: "AFA-9", user_id: U2 }],
  order_download_batches: [
    { id: U1, status: "completed", created_at: "2020-01-01T00:00:00Z" },
    { id: U2, status: "completed", created_at: "2099-01-01T00:00:00Z" },
  ],
  orders: [{ id: U1, status: "processing" }],
  api_orders: [],
}

const CARD_INPUTS: Record<string, { params?: any; query?: any; body?: any }> = {
  "GET /api/admin/batches/cleanup": {},
  "POST /api/admin/batches/cleanup": {},
  "GET /api/admin/payment-attempts": { query: { status: "pending" } },
  "PATCH /api/admin/payment-attempts": { body: { id: U1, status: "completed" } },
  "POST /api/admin/payment-reverify": { body: { orderId: U1, orderType: "data" } },
  "POST /api/admin/afa-update-status": { body: { submissionId: U1, status: "completed" } },
  "POST /api/admin/shop-orders/update-status": { body: { orderIds: [U1, U2], status: "completed" } },
  "POST /api/admin/orders/batch-statuses": { body: { orderIds: [U1, U2] } },
  "POST /api/admin/orders/delete-batches": { body: { fromDate: "2025-01-01" } },
  "POST /api/admin/orders/trigger-xpress-cron": {},
  "POST /api/admin/sync-orders": {},
}

describe("orders change cards", () => {
  const changes = ORDERS_ENTRIES.filter((e) => e.kind === "change" && !e.typedCard)

  it("has a sample input for every card entry", () => {
    for (const e of changes) expect(CARD_INPUTS[key(e.method, e.path)], e.id).toBeTruthy()
  })

  it("every sample input is valid for the entry's own schema", () => {
    for (const e of changes) {
      const inp = CARD_INPUTS[key(e.method, e.path)]
      if (e.body) expect(e.body.safeParse(inp.body ?? {}).success, e.id).toBe(true)
      if (e.query) expect(e.query.safeParse(inp.query ?? {}).success, e.id).toBe(true)
    }
  })

  for (const e of changes) {
    const inp = CARD_INPUTS[key(e.method, e.path)] ?? {}
    it(`${e.id}: summary and at least one line, no secrets or full contact details`, async () => {
      const c = await e.card!(inp, { db: fakeDb(tables), adminId: ADMIN })
      expect(c.summary.length).toBeGreaterThan(0)
      expect(c.lines.length).toBeGreaterThanOrEqual(1)
      const text = JSON.stringify(c)
      expect(text).not.toContain("SECRET123")
      expect(text).not.toContain("leak@example.com")
      expect(text).not.toContain("0241234567")
    })
    it(`${e.id}: still returns a card when the database fails`, async () => {
      const c = await e.card!(inp, { db: brokenDb, adminId: ADMIN })
      expect(c.summary.length).toBeGreaterThan(0)
      expect(c.lines.length).toBeGreaterThanOrEqual(1)
    })
  }

  it("shows status before and after, and the money effect, on shop order updates", async () => {
    const e = byKey("POST /api/admin/shop-orders/update-status")
    const c = await e.card!(CARD_INPUTS["POST /api/admin/shop-orders/update-status"], { db: fakeDb(tables), adminId: ADMIN })
    const text = JSON.stringify(c)
    expect(text).toMatch(/pending/)
    expect(text).toMatch(/completed/)
    expect(text).toMatch(/profit/i)
  })

  it("shows the amount and status change on a payment attempt override", async () => {
    const e = byKey("PATCH /api/admin/payment-attempts")
    const c = await e.card!(CARD_INPUTS["PATCH /api/admin/payment-attempts"], { db: fakeDb(tables), adminId: ADMIN })
    const text = JSON.stringify(c)
    expect(text).toContain("GHS 40.00")
    expect(text).toContain("WALLET-1")
    expect(text).toMatch(/pending/)
  })

  it("masks the registrant's phone on an AFA card", async () => {
    const e = byKey("POST /api/admin/afa-update-status")
    const c = await e.card!(CARD_INPUTS["POST /api/admin/afa-update-status"], { db: fakeDb(tables), adminId: ADMIN })
    expect(JSON.stringify(c)).toContain("024 *** 4567")
  })

  it("counts the batches a delete would remove", async () => {
    const e = byKey("POST /api/admin/orders/delete-batches")
    const c = await e.card!({ body: { fromDate: "2025-01-01T00:00:00Z" } }, { db: fakeDb(tables), adminId: ADMIN })
    expect(JSON.stringify(c)).toMatch(/\b1\b/)
  })
})
