// Admin re-verify: Hubtel payments are confirmed through Hubtel (confirmHubtelPayment), never through Paystack's
// verify, whose 404 would mark the order abandoned. Paystack rows behave as before.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => {
  type Row = Record<string, any>
  const tables: Record<string, Row[]> = {}
  const fake: any = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = []
      let patch: Row | null = null
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      const q: any = {
        select: () => q, order: () => q, limit: () => q, or: () => q, gte: () => q, lt: () => q, range: () => q,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
        update: (p: Row) => ((patch = p), q),
        insert: async () => ({ data: null, error: null }),
        single: async () => ({ data: rows()[0] ?? null, error: null }),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok: any, ko: any) => {
          const hit = rows()
          if (patch) for (const r of hit) Object.assign(r, patch)
          return Promise.resolve({ data: hit, error: null, count: hit.length }).then(ok, ko)
        },
      }
      return q
    },
  }
  const paystack: Record<string, { status: number; body: any }> = {}
  const fetchMock = vi.fn(async (url: string) => {
    const m = String(url).match(/transaction\/verify\/(.+)$/)
    if (m) {
      const r = paystack[decodeURIComponent(m[1])] ?? { status: 404, body: { status: false, message: "Transaction reference not found" } }
      return new Response(JSON.stringify(r.body), { status: r.status })
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  })
  const confirm = vi.fn(async (_ref: string) => "fulfilled")
  return { tables, fake, paystack, fetchMock, confirm }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: async () => ({ isAdmin: true }) }))
vi.mock("@/lib/hubtel-pay/confirm", () => ({ confirmHubtelPayment: (r: string) => h.confirm(r) }))

import { POST } from "./route"

const HREF = "c".repeat(32)
const post = async (body: unknown) => (await POST(new NextRequest("http://x/api/admin/payment-reverify", { method: "POST", body: JSON.stringify(body) }))).json()
const paystackCalls = () => h.fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("api.paystack.co"))
const shopOrder = (o: Record<string, any> = {}) => ({
  id: "o1", reference_code: "ORD-1", network: "MTN", customer_phone: "0241234567", volume_gb: "1", customer_name: "A",
  shop_id: "s1", profit_amount: 0, total_price: 10, payment_status: "pending", order_status: "pending", ...o,
})

beforeEach(() => {
  for (const k of Object.keys(h.tables)) delete h.tables[k]
  for (const k of Object.keys(h.paystack)) delete h.paystack[k]
  h.fetchMock.mockClear()
  h.confirm.mockReset()
  vi.stubGlobal("fetch", h.fetchMock)
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("POST /api/admin/payment-reverify", () => {
  it("a Hubtel payment is confirmed through Hubtel and reported from the row; Paystack is never asked", async () => {
    h.tables.shop_orders = [shopOrder()]
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-H", payment_method: "hubtel", created_at: "2026-11-04T09:00:00Z" }]
    h.tables.hubtel_payments = [{ reference: HREF, internal_reference: "WALLET-H", status: "pending", amount_pesewas: 1000, created_at: "2026-11-04T09:00:00Z" }]
    h.confirm.mockImplementation(async () => { h.tables.hubtel_payments[0].status = "paid"; return "fulfilled" })

    const out = await post({ orderId: "o1", orderType: "data" })

    expect(h.confirm).toHaveBeenCalledWith(HREF)
    expect(paystackCalls()).toEqual([])
    expect(out.results).toEqual([{ id: "o1", reference: "WALLET-H", order_type: "data", paystack_status: "success", action: "hubtel_paid" }])
    expect(out.verified).toBe(1)
    // The route itself changed nothing: the shared handler (inside confirm) does the order work.
    expect(h.tables.shop_orders[0].payment_status).toBe("pending")
  })

  it("an unpaid Hubtel payment stays pending (never abandoned)", async () => {
    h.tables.shop_orders = [shopOrder()]
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-H", payment_method: "paystack", created_at: "2026-11-04T09:00:00Z" }]
    h.tables.hubtel_payments = [{ reference: HREF, internal_reference: "WALLET-H", status: "pending", amount_pesewas: 1000, created_at: "2026-11-04T09:00:00Z" }]
    h.confirm.mockImplementation(async () => "pending")

    const out = await post({ bulk: true, bulkType: "data" })

    expect(paystackCalls()).toEqual([])
    expect(out.results[0]).toMatchObject({ paystack_status: "pending", action: "hubtel_pending" })
    expect(out.stillPending).toBe(1)
    expect(h.tables.shop_orders[0].payment_status).toBe("pending")
  })

  it("payment_method hubtel with no Hubtel row: not sent to Paystack", async () => {
    h.tables.shop_orders = [shopOrder()]
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-H", payment_method: "hubtel", created_at: "2026-11-04T09:00:00Z" }]

    const out = await post({ orderId: "o1", orderType: "data" })

    expect(h.confirm).not.toHaveBeenCalled()
    expect(paystackCalls()).toEqual([])
    expect(out.results[0]).toMatchObject({ paystack_status: "unknown", action: "hubtel_no_record" })
    expect(h.tables.shop_orders[0].payment_status).toBe("pending")
  })

  it("a Paystack row Paystack never heard of is still marked abandoned, as before", async () => {
    h.tables.shop_orders = [shopOrder()]
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-P", payment_method: "paystack", created_at: "2026-11-04T09:00:00Z" }]

    const out = await post({ orderId: "o1", orderType: "data" })

    expect(h.confirm).not.toHaveBeenCalled()
    expect(paystackCalls()).toEqual(["https://api.paystack.co/transaction/verify/WALLET-P"])
    expect(out.results[0]).toMatchObject({ paystack_status: "abandoned", action: "marked_abandoned" })
    expect(h.tables.shop_orders[0].payment_status).toBe("abandoned")
  })

  it("a Paystack success still completes the order, as before", async () => {
    h.tables.shop_orders = [shopOrder()]
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-P", created_at: "2026-11-04T09:00:00Z" }]
    h.paystack["WALLET-P"] = { status: 200, body: { status: true, data: { status: "success", amount: 1000 } } }

    const out = await post({ orderId: "o1", orderType: "data" })

    expect(out.results[0]).toMatchObject({ paystack_status: "success", action: "verified", fulfillment: "triggered" })
    expect(h.tables.shop_orders[0].payment_status).toBe("completed")
  })

  it("a Paystack success on an expired order: nothing flips, the wallet row records the money", async () => {
    h.tables.shop_orders = [shopOrder({ order_status: "expired", payment_status: "expired", profit_amount: 2 })]
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-P", status: "pending", created_at: "2026-11-04T09:00:00Z" }]
    h.paystack["WALLET-P"] = { status: 200, body: { status: true, data: { status: "success", amount: 1000 } } }

    const out = await post({ orderId: "o1", orderType: "data" })

    expect(out.results[0]).toMatchObject({ paystack_status: "success", action: "order_closed" })
    expect(h.tables.shop_orders[0].payment_status).toBe("expired")
    expect(h.tables.wallet_payments[0].status).toBe("completed")
    expect(h.tables.shop_profits ?? []).toEqual([])
  })
})
