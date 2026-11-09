// expire-stale-airtime must never expire an order the caller already paid for from the wallet (hubtel_wallet_payments,
// migration 0159): the RPC debits before the order's own handler marks it paid, so a debited order still reads
// pending_payment until the handler (or the sweep) runs.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

type Row = Record<string, any>
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  errors: {} as Record<string, { message: string; code?: string }>,
  updates: [] as { table: string; ids: string[] }[],
}))

/** In-memory PostgREST-ish builder: eq / in / lt filters, order, range / limit, select and update. */
function from(table: string) {
  const filters: ((r: Row) => boolean)[] = []
  let patch: Row | null = null
  let lo = 0
  let hi = Infinity
  let asc: string | null = null
  const q: any = {
    select: () => q,
    update: (p: Row) => { patch = p; return q },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q },
    in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q },
    lt: (c: string, v: string) => { filters.push((r) => String(r[c]) < v); return q },
    order: (c: string) => { asc = c; return q },
    range: (a: number, b: number) => { lo = a; hi = b; return q },
    limit: (n: number) => { hi = n - 1; return q },
    then: (res: (v: unknown) => unknown) => {
      if (h.errors[table]) return Promise.resolve({ data: null, error: h.errors[table] }).then(res)
      let rows = (h.tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      if (asc) rows = [...rows].sort((a, b) => String(a[asc!]).localeCompare(String(b[asc!])))
      if (patch) {
        for (const r of rows) Object.assign(r, patch)
        h.updates.push({ table, ids: rows.map((r) => r.id) })
        return Promise.resolve({ data: rows.map((r) => ({ id: r.id })), error: null }).then(res)
      }
      return Promise.resolve({ data: rows.slice(lo, hi + 1), error: null }).then(res)
    },
  }
  return q
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from }) }))
vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: () => ({ authorized: true }) }))
vi.mock("@/lib/payments/expire-shop-orders", () => ({ expireStaleShopOrders: async () => 0 }))

import { GET } from "./route"

const OLD = new Date(Date.now() - 6 * 3600_000).toISOString() // far past the 30-minute cutoff
const YEAR_OLD = new Date(Date.now() - 365 * 86_400_000).toISOString()
const FRESH = new Date(Date.now() - 60_000).toISOString()
const unpaid = (id: string, created_at = OLD): Row => ({ id, status: "pending_payment", payment_status: "pending_payment", created_at })
const pay = (order_table: string, order_id: string, state = "debited"): Row => ({ id: `p-${order_id}`, order_table, order_id, state })

const run = async () => (await GET(new NextRequest("http://localhost/api/cron/expire-stale-airtime"))).json()
const statusOf = (table: string, id: string) => h.tables[table].find((r) => r.id === id)?.status

beforeEach(() => {
  h.errors = {}
  h.updates = []
})

describe.each(["airtime_orders", "results_checker_orders"])("expire-stale-airtime on %s", (table) => {
  it("leaves an order with a debited wallet payment alone, however old, and still expires one without", async () => {
    h.tables = {
      [table]: [unpaid("paid-old"), unpaid("paid-ancient", YEAR_OLD), unpaid("unpaid-old"), unpaid("unpaid-fresh", FRESH)],
      hubtel_wallet_payments: [pay(table, "paid-old"), pay(table, "paid-ancient")],
    }
    await run()
    expect(statusOf(table, "paid-old")).toBe("pending_payment")
    expect(statusOf(table, "paid-ancient")).toBe("pending_payment")
    expect(statusOf(table, "unpaid-old")).toBe("expired")
    expect(statusOf(table, "unpaid-fresh")).toBe("pending_payment")
    expect(h.tables[table].find((r) => r.id === "unpaid-old")?.payment_status).toBe("expired")
  })

  it("leaves a needs_review wallet order alone too: it was paid, so it is never 'expired'", async () => {
    h.tables = { [table]: [unpaid("rev")], hubtel_wallet_payments: [pay(table, "rev", "needs_review")] }
    await run()
    expect(statusOf(table, "rev")).toBe("pending_payment")
  })

  it("a payment for the same id on another table does not protect the order", async () => {
    const other = table === "airtime_orders" ? "results_checker_orders" : "airtime_orders"
    h.tables = { [table]: [unpaid("x")], [other]: [], hubtel_wallet_payments: [pay(other, "x")] }
    await run()
    expect(statusOf(table, "x")).toBe("expired")
  })

  it("expires nothing when the wallet payments cannot be read", async () => {
    h.tables = { [table]: [unpaid("a")], hubtel_wallet_payments: [] }
    h.errors = { hubtel_wallet_payments: { message: "timeout", code: "57014" } }
    await run()
    expect(statusOf(table, "a")).toBe("pending_payment")
  })

  it("expires as before when hubtel_wallet_payments does not exist yet (0159 not applied)", async () => {
    h.tables = { [table]: [unpaid("a")] }
    h.errors = { hubtel_wallet_payments: { message: "missing", code: "PGRST205" } }
    await run()
    expect(statusOf(table, "a")).toBe("expired")
  })
})

it("reports the counts per table, as before", async () => {
  h.tables = {
    airtime_orders: [unpaid("a1"), unpaid("a2")],
    results_checker_orders: [unpaid("r1"), unpaid("r2")],
    hubtel_wallet_payments: [pay("airtime_orders", "a2")],
  }
  expect(await run()).toEqual({ expired: { airtime: 1, shop: 0, results_checker: 2 } })
})

it("pages past protected orders, so a long run of them never blocks the rest", async () => {
  const protectedRows = Array.from({ length: 450 }, (_, i) => unpaid(`p${String(i).padStart(3, "0")}`, new Date(Date.parse(OLD) - 3600_000).toISOString()))
  h.tables = {
    airtime_orders: [...protectedRows, unpaid("late")],
    results_checker_orders: [],
    hubtel_wallet_payments: protectedRows.map((r) => pay("airtime_orders", r.id)),
  }
  await run()
  expect(statusOf("airtime_orders", "late")).toBe("expired")
  expect(h.tables.airtime_orders.filter((r) => r.status === "expired")).toHaveLength(1)
})
