import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { BOT_UNPAID_FAILURE_REASON } from "@/lib/ussd-hubtel/order-tables"
import { BOT_SWEPT_SURFACES, expireStaleBotOrders, STALE_BOT_SWEEP_CHUNK } from "./stale-sweep"

type Row = Record<string, any>
const NOW = Date.parse("2026-10-20T12:00:00.000Z")
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()

/**
 * In-memory PostgREST-ish fake: select / update + eq / in / lt / order / limit, executed on await. `hooks.afterSelect`
 * runs after a select returns (to simulate a concurrent write between the sweep's select and its update).
 */
function fakeDb(tables: Record<string, Row[]>, hooks: { afterSelect?: (table: string) => void; failOn?: (table: string, op: string) => boolean } = {}) {
  const log: { table: string; op: "select" | "update"; inSizes: number[] }[] = []
  class Q {
    private filters: ((r: Row) => boolean)[] = []
    private patch: Row | null = null
    private lim: number | null = null
    private ord: { col: string; asc: boolean } | null = null
    private inSizes: number[] = []
    constructor(private table: string) {}
    select() { return this }
    update(p: Row) { this.patch = p; return this }
    eq(c: string, v: unknown) { this.filters.push(r => r[c] === v); return this }
    in(c: string, vs: unknown[]) { this.inSizes.push(vs.length); this.filters.push(r => vs.includes(r[c])); return this }
    lt(c: string, v: string) { this.filters.push(r => r[c] < v); return this }
    order(col: string, o: { ascending: boolean }) { this.ord = { col, asc: o.ascending }; return this }
    limit(n: number) { this.lim = n; return this }
    then(ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) {
      const op = this.patch ? "update" : "select"
      log.push({ table: this.table, op, inSizes: this.inSizes })
      if (hooks.failOn?.(this.table, op)) return Promise.resolve({ data: null, error: { message: "boom", code: "XX000" } }).then(ok, ko)
      let rows = (tables[this.table] ?? []).filter(r => this.filters.every(f => f(r)))
      if (this.patch) {
        for (const r of rows) Object.assign(r, this.patch)
      } else {
        if (this.ord) rows = [...rows].sort((a, b) => (a[this.ord!.col] < b[this.ord!.col] ? -1 : 1) * (this.ord!.asc ? 1 : -1))
        if (this.lim !== null) rows = rows.slice(0, this.lim)
      }
      const data = rows.map(r => ({ id: r.id }))
      if (!this.patch) hooks.afterSelect?.(this.table)
      return Promise.resolve({ data, error: null }).then(ok, ko)
    }
  }
  return { db: { from: (t: string) => new Q(t) } as unknown as SupabaseClient, log }
}

const order = (id: string, over: Row = {}): Row => ({
  id, channel: "bots", bot_surface: "ussd", status: "pending", payment_status: "unpaid", created_at: ago(45),
  failure_reason: null, ...over,
})
const payment = (id: string, orderId: string, orderType: string, over: Row = {}): Row => ({
  id, order_id: orderId, order_type: orderType, status: "pending", ...over,
})

describe("expireStaleBotOrders", () => {
  it("fails stale unpaid pending Uzo bot orders in both tables (guarded patch) and their pending payments", async () => {
    const tables = {
      hubtel_bill_orders: [order("b1"), order("b2", { bot_surface: "ussd_shop" })],
      hubtel_data_orders: [order("d1", { bot_surface: "ussd_shop" })],
      wallet_payments: [
        payment("p1", "b1", "cs_bill"), payment("p2", "b2", "cs_bill"), payment("p3", "d1", "cs_bundle"),
        payment("p4", "b1", "cs_bill", { status: "completed" }), // not pending: untouched
        payment("p5", "d1", "cs_bill"),                          // wrong order type for d1: untouched
        payment("p6", "zz", "cs_bundle"),                          // another order: untouched
      ],
    }
    const { db } = fakeDb(tables)
    const r = await expireStaleBotOrders(db, { now: NOW })
    expect(r.tables.hubtel_bill_orders).toEqual({ found: 2, failed: 2, payments: 2 })
    expect(r.tables.hubtel_data_orders).toEqual({ found: 1, failed: 1, payments: 1 })
    expect(r.errors).toBe(0)
    for (const o of [...tables.hubtel_bill_orders, ...tables.hubtel_data_orders]) {
      expect(o).toMatchObject({ status: "failed", failure_reason: BOT_UNPAID_FAILURE_REASON, payment_status: "unpaid" })
      expect(typeof o.updated_at).toBe("string")
    }
    const status = Object.fromEntries(tables.wallet_payments.map(p => [p.id, p.status]))
    expect(status).toEqual({ p1: "failed", p2: "failed", p3: "failed", p4: "completed", p5: "pending", p6: "pending" })
  })

  it("fails stale unpaid pending WhatsApp bot orders (main + shop) in both tables and their pending cs_* payments", async () => {
    const tables = {
      hubtel_bill_orders: [order("wb1", { bot_surface: "whatsapp" }), order("wb2", { bot_surface: "whatsapp_shop" })],
      hubtel_data_orders: [order("wd1", { bot_surface: "whatsapp_shop" }), order("wd2", { bot_surface: "whatsapp" })],
      wallet_payments: [
        payment("q1", "wb1", "cs_bill"), payment("q2", "wb2", "cs_bill"), payment("q3", "wd1", "cs_bundle"),
        payment("q4", "wd2", "cs_bundle"), payment("q5", "wd2", "cs_bundle", { status: "completed" }),
      ],
    }
    const r = await expireStaleBotOrders(fakeDb(tables).db, { now: NOW })
    expect(r.tables.hubtel_bill_orders).toEqual({ found: 2, failed: 2, payments: 2 })
    expect(r.tables.hubtel_data_orders).toEqual({ found: 2, failed: 2, payments: 2 })
    for (const o of [...tables.hubtel_bill_orders, ...tables.hubtel_data_orders]) {
      expect(o).toMatchObject({ status: "failed", failure_reason: BOT_UNPAID_FAILURE_REASON, payment_status: "unpaid" })
    }
    const status = Object.fromEntries(tables.wallet_payments.map(p => [p.id, p.status]))
    expect(status).toEqual({ q1: "failed", q2: "failed", q3: "failed", q4: "failed", q5: "completed" })
  })

  it("fails a swept order's payment rows Paystack left 'ongoing' / 'abandoned' too; 'completed' is never touched", async () => {
    const tables = {
      hubtel_bill_orders: [order("b1", { bot_surface: "whatsapp" })],
      hubtel_data_orders: [] as Row[],
      wallet_payments: [
        payment("o1", "b1", "cs_bill", { status: "ongoing" }),
        payment("o2", "b1", "cs_bill", { status: "abandoned" }),
        payment("o3", "b1", "cs_bill", { status: "completed" }),
      ],
    }
    const r = await expireStaleBotOrders(fakeDb(tables).db, { now: NOW })
    expect(r.tables.hubtel_bill_orders).toEqual({ found: 1, failed: 1, payments: 2 })
    const status = Object.fromEntries(tables.wallet_payments.map(p => [p.id, p.status]))
    expect(status).toEqual({ o1: "failed", o2: "failed", o3: "completed" })
  })

  it("the swept surfaces are exactly Uzo + WhatsApp (never hubtel_ussd)", () => {
    expect([...BOT_SWEPT_SURFACES].sort()).toEqual(["ussd", "ussd_shop", "whatsapp", "whatsapp_shop"])
  })

  it("WhatsApp: paid and recent rows are untouched; hubtel_ussd rows are untouched", async () => {
    const keep = [
      order("wa-paid", { bot_surface: "whatsapp", payment_status: "paid" }),
      order("was-paid", { bot_surface: "whatsapp_shop", payment_status: "paid" }),
      order("wa-fresh", { bot_surface: "whatsapp", created_at: ago(29) }),
      order("was-fresh", { bot_surface: "whatsapp_shop", created_at: ago(5) }),
      order("hubtel", { bot_surface: "hubtel_ussd" }),
    ]
    const tables = {
      hubtel_bill_orders: keep.map(r => ({ ...r })),
      hubtel_data_orders: keep.map(r => ({ ...r })),
      wallet_payments: keep.map(r => payment(`p-${r.id}`, r.id, "cs_bill")),
    }
    const before = JSON.parse(JSON.stringify(tables))
    const r = await expireStaleBotOrders(fakeDb(tables).db, { now: NOW })
    expect(r.tables.hubtel_bill_orders.found).toBe(0)
    expect(r.tables.hubtel_data_orders.found).toBe(0)
    expect(tables).toEqual(before)
  })

  it("never touches paid rows, Hubtel USSD rows, storefront / other-channel rows, fresh or closed rows", async () => {
    const keep = [
      order("paid", { payment_status: "paid" }),
      order("hubtel", { bot_surface: "hubtel_ussd" }),
      order("store", { channel: "storefront", bot_surface: null }),
      order("dash", { channel: "dashboard", bot_surface: null }),
      order("fresh", { created_at: ago(29) }),
      order("done", { status: "completed" }),
      order("failed", { status: "failed", failure_reason: "x" }),
    ]
    const tables = {
      hubtel_bill_orders: keep.map(r => ({ ...r })),
      hubtel_data_orders: keep.map(r => ({ ...r })),
      wallet_payments: keep.map(r => payment(`p-${r.id}`, r.id, "cs_bill")),
    }
    const before = JSON.parse(JSON.stringify(tables))
    const r = await expireStaleBotOrders(fakeDb(tables).db, { now: NOW })
    expect(r.tables.hubtel_bill_orders).toEqual({ found: 0, failed: 0, payments: 0 })
    expect(r.tables.hubtel_data_orders).toEqual({ found: 0, failed: 0, payments: 0 })
    expect(tables).toEqual(before)
  })

  it("an order paid between the select and the update is not failed, and its payment is left alone", async () => {
    const tables = {
      hubtel_bill_orders: [order("b1"), order("b2")],
      hubtel_data_orders: [] as Row[],
      wallet_payments: [payment("p1", "b1", "cs_bill"), payment("p2", "b2", "cs_bill")],
    }
    const { db } = fakeDb(tables, {
      afterSelect: t => { if (t === "hubtel_bill_orders") tables.hubtel_bill_orders[0].payment_status = "paid" },
    })
    const r = await expireStaleBotOrders(db, { now: NOW })
    expect(r.tables.hubtel_bill_orders).toEqual({ found: 2, failed: 1, payments: 1 })
    expect(tables.hubtel_bill_orders[0]).toMatchObject({ status: "pending", payment_status: "paid" })
    expect(tables.hubtel_bill_orders[1]).toMatchObject({ status: "failed" })
    expect(tables.wallet_payments.map(p => p.status)).toEqual(["pending", "failed"])
  })

  it("bounded: at most `batch` orders per table per run, oldest first; chunked updates; the next run takes the rest", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => order(`b${String(i).padStart(3, "0")}`, { created_at: ago(300 - i) }))
    const tables = {
      hubtel_bill_orders: rows,
      hubtel_data_orders: [] as Row[],
      wallet_payments: rows.map(o => payment(`p-${o.id}`, o.id, "cs_bill")),
    }
    const { db, log } = fakeDb(tables)
    const r1 = await expireStaleBotOrders(db, { now: NOW })
    expect(r1.tables.hubtel_bill_orders).toEqual({ found: 200, failed: 200, payments: 200 })
    expect(rows.slice(0, 200).every(o => o.status === "failed")).toBe(true)
    expect(rows.slice(200).every(o => o.status === "pending")).toBe(true)
    for (const e of log) for (const n of e.inSizes) expect(n).toBeLessThanOrEqual(STALE_BOT_SWEEP_CHUNK)
    const r2 = await expireStaleBotOrders(db, { now: NOW })
    expect(r2.tables.hubtel_bill_orders).toEqual({ found: 50, failed: 50, payments: 50 })
    expect(tables.wallet_payments.every(p => p.status === "failed")).toBe(true)
  })

  it("a DB error on one table is logged and counted; the other table is still swept; never throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const tables = {
      hubtel_bill_orders: [order("b1")],
      hubtel_data_orders: [order("d1")],
      wallet_payments: [payment("p1", "b1", "cs_bill"), payment("p2", "d1", "cs_bundle")],
    }
    const { db } = fakeDb(tables, { failOn: (t, op) => t === "hubtel_bill_orders" && op === "select" })
    const r = await expireStaleBotOrders(db, { now: NOW })
    expect(r.errors).toBe(1)
    expect(r.tables.hubtel_bill_orders).toEqual({ found: 0, failed: 0, payments: 0 })
    expect(r.tables.hubtel_data_orders).toEqual({ found: 1, failed: 1, payments: 1 })
    expect(tables.hubtel_bill_orders[0].status).toBe("pending")
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it("a payments update error still leaves the orders failed (counted as an error)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const tables = { hubtel_bill_orders: [order("b1")], hubtel_data_orders: [] as Row[], wallet_payments: [payment("p1", "b1", "cs_bill")] }
    const { db } = fakeDb(tables, { failOn: t => t === "wallet_payments" })
    const r = await expireStaleBotOrders(db, { now: NOW })
    expect(r.tables.hubtel_bill_orders).toEqual({ found: 1, failed: 1, payments: 0 })
    expect(r.errors).toBe(1)
    expect(tables.hubtel_bill_orders[0].status).toBe("failed")
    err.mockRestore()
  })
})
