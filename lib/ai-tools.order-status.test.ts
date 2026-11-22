// search_order_status against the real tracking route handlers: the AI must keep working on the reduced response.
import { afterEach, expect, it, vi } from "vitest"

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const order = {
        id: "data-1", reference_code: "ORD-1", network: "MTN", volume_gb: 5, total_price: 25,
        order_status: "completed", payment_status: "completed", created_at: "2026-11-20T10:00:00.000Z",
        customer_name: "Testa Buyerson", customer_email: "testa@example.test", customer_phone: "0200000123",
        shop_id: "shop-1",
      }
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        single: async () => ({ data: table === "shop_orders" ? order : { id: "shop-1" }, error: null }),
        then: (resolve: any) =>
          Promise.resolve({ data: table === "shop_orders" ? [order] : [], error: null }).then(resolve),
      }
      return chain
    },
  }),
}))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async () => ({ allowed: true }) }))

import { executeToolCall } from "@/lib/ai-tools"
import { GET } from "@/app/api/shop/orders/[orderId]/route"
import { POST } from "@/app/api/shop/orders/search/route"

afterEach(() => vi.unstubAllGlobals())

const run = (input: Record<string, unknown>) => {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
    url.endsWith("/search")
      ? POST(new Request(url, init) as any)
      : GET(new Request(url, init) as any, { params: Promise.resolve({ orderId: "data-1" }) }))
  return executeToolCall("search_order_status", input, { context: "storefront", shopId: "shop-1", baseUrl: "http://x" })
}

it("phone lookup still reports the order", async () => {
  expect(await run({ phone_number: "0200000123" })).toEqual({
    found: 1,
    orders: [{
      reference: "ORD-1", type: "data", network: "MTN", volume_gb: 5, price: 25,
      order_status: "completed", payment_status: "completed", date: "2026-11-20T10:00:00.000Z",
    }],
  })
})

it("id lookup reports the order with masked buyer details", async () => {
  expect(await run({ order_id: "data-1" })).toMatchObject({
    reference_code: "ORD-1", order_status: "completed",
    customer_name: "Testa", customer_email: "t***@example.test", customer_phone: "*******123",
  })
})
