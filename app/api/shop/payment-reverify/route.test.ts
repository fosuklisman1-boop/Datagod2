// Shop-owner re-verify: Hubtel payments go through confirmHubtelPayment, never Paystack's verify (whose 404 would mark
// the order abandoned). Paystack rows behave as before.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => {
  type Row = Record<string, any>
  const tables: Record<string, Row[]> = {}
  const fake: any = {
    auth: { getUser: async () => ({ data: { user: { id: "owner1" } }, error: null }) },
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = []
      let patch: Row | null = null
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      const q: any = {
        select: () => q, order: () => q, limit: () => q, or: () => q, range: () => q,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
        update: (p: Row) => ((patch = p), q),
        insert: async () => ({ data: null, error: null }),
        single: async () => ({ data: rows()[0] ?? null, error: rows()[0] ? null : { message: "none" } }),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok: any, ko: any) => {
          const hit = rows()
          if (patch) for (const r of hit) Object.assign(r, patch)
          return Promise.resolve({ data: hit, error: null }).then(ok, ko)
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
  const confirm = vi.fn(async (_ref: string) => "pending")
  return { tables, fake, paystack, fetchMock, confirm }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/hubtel-pay/confirm", () => ({ confirmHubtelPayment: (r: string) => h.confirm(r) }))

import { POST } from "./route"

const HREF = "d".repeat(32)
const post = async (body: unknown) => {
  const res = await POST(new NextRequest("http://x/api/shop/payment-reverify", {
    method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer t" },
  }))
  return { status: res.status, body: await res.json() }
}
const paystackCalls = () => h.fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("api.paystack.co"))

beforeEach(() => {
  for (const k of Object.keys(h.tables)) delete h.tables[k]
  for (const k of Object.keys(h.paystack)) delete h.paystack[k]
  h.fetchMock.mockClear()
  h.confirm.mockReset()
  vi.stubGlobal("fetch", h.fetchMock)
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  h.tables.user_shops = [{ id: "s1", user_id: "owner1" }]
  h.tables.shop_orders = [{
    id: "o1", reference_code: "ORD-1", network: "MTN", customer_phone: "0241234567", volume_gb: "1", customer_name: "A",
    shop_id: "s1", profit_amount: 0, total_price: 10, payment_status: "pending", order_status: "pending",
  }]
})

describe("POST /api/shop/payment-reverify", () => {
  it("a Hubtel payment is confirmed through Hubtel and reported from the row", async () => {
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-H", payment_method: "hubtel", created_at: "2026-11-04T09:00:00Z" }]
    h.tables.hubtel_payments = [{ reference: HREF, internal_reference: "WALLET-H", status: "pending", amount_pesewas: 1000, created_at: "2026-11-04T09:00:00Z" }]
    h.confirm.mockImplementation(async () => { h.tables.hubtel_payments[0].status = "failed"; return "failed" })

    const out = await post({ orderId: "o1" })

    expect(h.confirm).toHaveBeenCalledWith(HREF)
    expect(paystackCalls()).toEqual([])
    expect(out).toEqual({ status: 200, body: { paystack_status: "failed", action: "hubtel_failed" } })
    expect(h.tables.shop_orders[0].payment_status).toBe("pending") // the route itself writes nothing
  })

  it("an open Hubtel payment found only by its live row is reported pending, never abandoned", async () => {
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-H", payment_method: null, created_at: "2026-11-04T09:00:00Z" }]
    h.tables.hubtel_payments = [{ reference: HREF, internal_reference: "WALLET-H", status: "confirming", amount_pesewas: 1000, created_at: "2026-11-04T09:00:00Z" }]
    h.confirm.mockImplementation(async () => "ignored")

    const out = await post({ orderId: "o1" })

    expect(paystackCalls()).toEqual([])
    expect(out.body).toEqual({ paystack_status: "pending", action: "hubtel_confirming" })
    expect(h.tables.shop_orders[0].payment_status).toBe("pending")
  })

  it("payment_method hubtel with no Hubtel row: not sent to Paystack", async () => {
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-H", payment_method: "hubtel", created_at: "2026-11-04T09:00:00Z" }]
    const out = await post({ orderId: "o1" })
    expect(paystackCalls()).toEqual([])
    expect(out.body).toEqual({ paystack_status: "unknown", action: "hubtel_no_record" })
  })

  it("a Paystack row Paystack never heard of is still marked abandoned, as before", async () => {
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-P", payment_method: "paystack", created_at: "2026-11-04T09:00:00Z" }]
    const out = await post({ orderId: "o1" })
    expect(h.confirm).not.toHaveBeenCalled()
    expect(paystackCalls()).toEqual(["https://api.paystack.co/transaction/verify/WALLET-P"])
    expect(out.body).toEqual({ paystack_status: "abandoned", action: "marked_abandoned" })
    expect(h.tables.shop_orders[0].payment_status).toBe("abandoned")
  })

  it("a Paystack success still completes the order, as before", async () => {
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-P", created_at: "2026-11-04T09:00:00Z" }]
    h.paystack["WALLET-P"] = { status: 200, body: { status: true, data: { status: "success", amount: 1000 } } }
    const out = await post({ orderId: "o1" })
    expect(out.body).toEqual({ paystack_status: "success", action: "verified", fulfillment: "triggered" })
    expect(h.tables.shop_orders[0].payment_status).toBe("completed")
  })
})
