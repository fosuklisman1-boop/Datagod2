import { beforeEach, describe, expect, it, vi } from "vitest"

type Call = { table: string; select: string; filters: Array<[string, unknown]>; limit?: number }
const h = vi.hoisted(() => ({
  calls: [] as any[],
  rows: {} as Record<string, unknown[]>,
  shop: { id: "shop-1" } as { id: string } | null,
  allowed: true,
}))

// Returns whole rows whatever was selected, so a leak cannot hide behind the select list.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const call: Call = { table, select: "", filters: [] }
      h.calls.push(call)
      const chain: any = {
        select: (columns = "*") => ((call.select = columns), chain),
        eq: (column: string, value: unknown) => (call.filters.push([column, value]), chain),
        or: (filter: string) => (call.filters.push(["or", filter]), chain),
        order: () => chain,
        limit: (n: number) => ((call.limit = n), chain),
        single: async () => ({ data: h.shop, error: null }),
        then: (resolve: any) => Promise.resolve({ data: h.rows[table] ?? null, error: null }).then(resolve),
      }
      return chain
    },
  }),
}))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async () => ({ allowed: h.allowed }) }))

import { POST } from "./route"

const KEYS = [
  "id", "type", "reference_code", "network", "volume_gb", "total_price",
  "order_status", "payment_status", "created_at", "updated_at",
].sort()

// Every private column, plus one nobody has invented yet.
const SECRETS = {
  customer_name: "SECRET Full Name",
  customer_email: "secret.buyer@example.test",
  customer_phone: "0200000123",
  beneficiary_phone: "0200000124",
  dialing_phone: "0200000125",
  base_price: 7777.01,
  profit_amount: 7777.02,
  parent_profit_amount: 7777.03,
  fee_amount: 7777.04,
  merchant_commission: 7777.05,
  shop_id: "SECRET-shop",
  parent_shop_id: "SECRET-parent",
  shop_package_id: "SECRET-package",
  paystack_reference: "SECRET-gateway",
  notes: "SECRET note",
  queue: "SECRET-queue",
  some_future_column: "SECRET future",
}
const dataRow = (over: object = {}) => ({
  ...SECRETS,
  id: "data-1", reference_code: "ORD-1", network: "MTN", volume_gb: 5, total_price: 25,
  order_status: "completed", payment_status: "completed",
  created_at: "2026-11-20T10:00:00.000Z", updated_at: "2026-11-20T10:05:00.000Z",
  ...over,
})
const airtimeRow = (over: object = {}) => ({
  ...SECRETS,
  id: "air-1", reference_code: "AT-1", network: "Telecel", airtime_amount: 10, total_paid: "10.50",
  status: "processing", payment_status: "completed",
  created_at: "2026-11-21T10:00:00.000Z", updated_at: "2026-11-21T10:05:00.000Z",
  ...over,
})

const send = (body: string) =>
  POST(new Request("http://x/api/shop/orders/search", { method: "POST", body }) as any)
const search = (body: unknown = { phone: "0200000123", shopSlug: "test-shop" }) => send(JSON.stringify(body))
const callFor = (table: string): Call => h.calls.find((c) => c.table === table)

beforeEach(() => {
  h.calls.length = 0
  h.rows = { shop_orders: [dataRow()], airtime_orders: [airtimeRow()] }
  h.shop = { id: "shop-1" }
  h.allowed = true
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("POST /api/shop/orders/search: public output", () => {
  it.each(["data", "airtime"])("returns exactly the public keys for a %s row", async (type) => {
    const { orders } = await (await search()).json()
    const row = orders.find((o: any) => o.type === type)
    expect(Object.keys(row).sort()).toEqual(KEYS)
  })

  it("cannot leak a column the database happened to return", async () => {
    const text = await (await search()).text()
    for (const value of Object.values(SECRETS)) expect(text).not.toContain(String(value))
  })

  it("selects only the public shop_orders columns", async () => {
    await search()
    expect(callFor("shop_orders").select.split(",").map((c) => c.trim()).sort()).toEqual(KEYS.filter((k) => k !== "type"))
  })

  it("selects only the airtime columns the output is built from", async () => {
    await search()
    expect(callFor("airtime_orders").select.split(",").map((c) => c.trim()).sort()).toEqual([
      "airtime_amount", "created_at", "id", "network", "payment_status",
      "reference_code", "status", "total_paid", "updated_at",
    ])
  })

  it("never uses a wildcard select", async () => {
    await search()
    for (const call of h.calls) expect(call.select).not.toContain("*")
  })

  it("keeps the envelope, newest-first order and values", async () => {
    const res = await search()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      count: 2,
      orders: [
        {
          id: "air-1", type: "airtime", reference_code: "AT-1", network: "Telecel", volume_gb: 10, total_price: 10.5,
          order_status: "processing", payment_status: "completed",
          created_at: "2026-11-21T10:00:00.000Z", updated_at: "2026-11-21T10:05:00.000Z",
        },
        {
          id: "data-1", type: "data", reference_code: "ORD-1", network: "MTN", volume_gb: 5, total_price: 25,
          order_status: "completed", payment_status: "completed",
          created_at: "2026-11-20T10:00:00.000Z", updated_at: "2026-11-20T10:05:00.000Z",
        },
      ],
    })
  })

  it("keeps the airtime fallbacks", async () => {
    h.rows = { airtime_orders: [airtimeRow({ reference_code: null, total_paid: null, status: null })] }
    const { orders } = await (await search()).json()
    expect(orders[0]).toMatchObject({ reference_code: "air-1", total_price: 0, order_status: "pending" })
  })

  it("returns an empty list when nothing matches", async () => {
    h.rows = {}
    expect(await (await search()).json()).toEqual({ success: true, orders: [], count: 0 })
  })
})

describe("POST /api/shop/orders/search: lookup", () => {
  it("scopes both tables to the shop and trimmed phone, limited to 200", async () => {
    await search({ phone: " 0200000123 ", shopSlug: "test-shop" })
    for (const [table, column] of [["shop_orders", "customer_phone"], ["airtime_orders", "beneficiary_phone"]]) {
      expect(callFor(table).filters).toEqual([["shop_id", "shop-1"], [column, "0200000123"]])
      expect(callFor(table).limit).toBe(200)
    }
  })

  it.each([undefined, null])("still accepts a shop id when the slug is %s", async (shopSlug) => {
    expect((await search({ phone: "0200000123", shopId: "shop-1", shopSlug })).status).toBe(200)
  })

  it("still answers 404 for an unknown shop", async () => {
    h.shop = null
    expect((await search()).status).toBe(404)
  })

  it("still rate limits", async () => {
    h.allowed = false
    expect((await search()).status).toBe(429)
    expect(h.calls).toEqual([])
  })
})

describe("POST /api/shop/orders/search: bad input", () => {
  const notStrings = [200000123, 0, true, false, {}, ["0200000123"]]

  it.each(notStrings)("rejects phone %j with 400", async (phone) => {
    expect((await search({ phone, shopSlug: "test-shop" })).status).toBe(400)
    expect(h.calls).toEqual([])
  })

  it.each(notStrings)("rejects slug %j with 400", async (shopSlug) => {
    expect((await search({ phone: "0200000123", shopSlug, shopId: "shop-1" })).status).toBe(400)
    expect(h.calls).toEqual([])
  })

  it.each(notStrings)("rejects shop id %j with 400", async (shopId) => {
    expect((await search({ phone: "0200000123", shopId })).status).toBe(400)
    expect(h.calls).toEqual([])
  })

  it("rejects a blank phone, which would match every order saved without one", async () => {
    expect((await search({ phone: "   ", shopId: "shop-1" })).status).toBe(400)
    expect(h.calls).toEqual([])
  })

  it.each(["null", "[]", '"text"', "not json 0200000123"])("rejects body %s with 400 and logs nothing", async (body) => {
    vi.mocked(console.error).mockClear()
    expect((await send(body)).status).toBe(400)
    expect(console.error).not.toHaveBeenCalled()
  })
})
