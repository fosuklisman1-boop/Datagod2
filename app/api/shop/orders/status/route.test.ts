import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  selects: {} as Record<string, string>,
  row: null as Record<string, unknown> | null,
}))

// Returns the whole row whatever was selected, so a leak cannot hide behind the select list.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const chain: any = {
        select: (columns = "*") => ((h.selects[table] = columns), chain),
        eq: () => chain,
        single: async () => ({ data: h.row, error: h.row ? null : { code: "PGRST116" } }),
      }
      return chain
    },
  }),
}))

import { GET } from "./route"

const SECRETS = {
  customer_name: "SECRET Full Name",
  customer_email: "secret.buyer@example.test",
  customer_phone: "0200000123",
  dialing_phone: "0200000125",
  base_price: 7777.01,
  profit_amount: 7777.02,
  fee_amount: 7777.04,
  merchant_commission: 7777.05,
  shop_id: "SECRET-shop",
  notes: "SECRET note",
  some_future_column: "SECRET future",
}

const get = (query: string) => GET(new Request(`http://x/api/shop/orders/status?${query}`) as any)

beforeEach(() => {
  h.selects = {}
  h.row = null
})

describe("GET /api/shop/orders/status", () => {
  it("airtime: returns only what the confirmation page shows, recipient phone masked", async () => {
    h.row = {
      ...SECRETS, id: "air-1", reference_code: "AT-1", network: "MTN", status: "completed",
      payment_status: "completed", airtime_amount: 10, total_paid: "10.50",
      beneficiary_phone: "0244000999", created_at: "2026-11-21T10:00:00.000Z",
    }
    const res = await get("orderId=air-1&type=airtime")
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      id: "air-1", reference_code: "AT-1", network: "MTN", status: "completed", payment_status: "completed",
      airtime_amount: 10, total_paid: "10.50", beneficiary_phone: "*******999", created_at: "2026-11-21T10:00:00.000Z",
    })
  })

  it("data: returns only the public tracking fields", async () => {
    h.row = {
      ...SECRETS, id: "data-1", reference_code: "ORD-1", network: "MTN", volume_gb: 5, total_price: 25,
      order_status: "completed", payment_status: "completed",
      created_at: "2026-11-20T10:00:00.000Z", updated_at: "2026-11-20T10:05:00.000Z",
    }
    const { data } = await (await get("orderId=data-1")).json()
    expect(Object.keys(data).sort()).toEqual([
      "created_at", "id", "network", "order_status", "payment_status", "reference_code", "total_price", "updated_at", "volume_gb",
    ])
  })

  it.each(["type=airtime", "type=data"])("never leaks a private column (%s)", async (type) => {
    h.row = { ...SECRETS, id: "x", beneficiary_phone: "0244000999" }
    const text = await (await get(`orderId=x&${type}`)).text()
    for (const value of Object.values(SECRETS)) expect(text).not.toContain(String(value))
    expect(text).not.toContain("0244000999")
  })

  it("never uses a wildcard select", async () => {
    h.row = { id: "x" }
    await get("orderId=x&type=airtime")
    await get("orderId=x")
    for (const columns of Object.values(h.selects)) expect(columns).not.toContain("*")
  })

  it("still answers 400 without an id and 404 for an unknown order", async () => {
    expect((await get("type=airtime")).status).toBe(400)
    expect((await get("orderId=missing")).status).toBe(404)
  })
})
