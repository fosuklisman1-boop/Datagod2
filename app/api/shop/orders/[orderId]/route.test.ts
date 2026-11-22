import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  selects: {} as Record<string, string>,
  order: null as Record<string, unknown> | null,
  error: null as { code: string; message: string } | null,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const chain: any = {
        select: (columns = "*") => ((h.selects[table] = columns), chain),
        eq: () => chain,
        single: async () => {
          if (table === "user_shops") return { data: { shop_name: "Test Shop" }, error: null }
          if (table === "shop_settings") return { data: { whatsapp_link: null }, error: null }
          return { data: h.order, error: h.error }
        },
      }
      return chain
    },
  }),
}))

import { GET } from "./route"

const row = (over: object = {}) => ({
  id: "data-1", reference_code: "ORD-1", order_status: "completed", payment_status: "completed",
  customer_name: "Testa Buyerson", customer_email: "testa.buyerson@example.test", customer_phone: "0200000123",
  network: "MTN", volume_gb: 5, total_price: 25, created_at: "2026-11-20T10:00:00.000Z", shop_id: "shop-1",
  ...over,
})
const get = () => GET(new Request("http://x") as any, { params: Promise.resolve({ orderId: "data-1" }) })

beforeEach(() => {
  h.selects = {}
  h.order = row()
  h.error = null
})

describe("GET /api/shop/orders/[orderId]", () => {
  it("keeps the field names and masks the buyer's values", async () => {
    expect(await (await get()).json()).toEqual({
      success: true,
      order: {
        ...row(),
        customer_name: "Testa",
        customer_email: "t***@example.test",
        customer_phone: "*******123",
      },
      shopName: "Test Shop",
      shopWhatsapp: null,
    })
  })

  it("contains no raw buyer value anywhere in the response", async () => {
    const text = await (await get()).text()
    for (const raw of ["Buyerson", "testa.buyerson", "0200000123"]) expect(text).not.toContain(raw)
  })

  it("cannot leak a column the database happened to return", async () => {
    h.order = row({ base_price: 7777.01, profit_amount: 7777.02, some_future_column: "SECRET" })
    const text = await (await get()).text()
    for (const secret of ["7777.01", "7777.02", "SECRET"]) expect(text).not.toContain(secret)
  })

  it.each([null, "", "   ", 200000123, {}])("turns a %j buyer value into null", async (value) => {
    h.order = row({ customer_name: value, customer_email: value, customer_phone: value })
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).order).toMatchObject({ customer_name: null, customer_email: null, customer_phone: null })
  })

  it("never uses a wildcard select", async () => {
    await get()
    for (const columns of Object.values(h.selects)) expect(columns).not.toContain("*")
  })

  it("still answers 404 for an unknown order", async () => {
    h.error = { code: "PGRST116", message: "no rows" }
    expect((await get()).status).toBe(404)
  })
})
