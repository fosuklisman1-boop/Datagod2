// The Paystack verify cron must never mark a Hubtel payment's order abandoned/failed (Paystack answers 404 for a
// reference it never saw), and must behave exactly as before for Paystack rows.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => {
  type Row = Record<string, any>
  const tables: Record<string, Row[]> = {}
  const updates: { table: string; patch: Row }[] = []
  const errors: Record<string, { code?: string; message: string }> = {}
  const fake: any = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = []
      let patch: Row | null = null
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      const q: any = {
        select: () => q, order: () => q, limit: () => q, lt: () => q, not: () => q,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
        update: (p: Row) => ((patch = p), q),
        single: async () => ({ data: rows()[0] ?? null, error: null }),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok: any, ko: any) => {
          if (errors[table]) return Promise.resolve({ data: null, error: errors[table] }).then(ok, ko)
          const hit = rows()
          if (patch) { updates.push({ table, patch }); for (const r of hit) Object.assign(r, patch) }
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
  return { tables, updates, errors, fake, paystack, fetchMock }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: () => ({ authorized: true }) }))
vi.mock("@/lib/internal-url", () => ({ getInternalBaseUrl: () => "http://localhost" }))

import { GET } from "./route"

const run = async () => (await GET(new NextRequest("http://x/api/cron/verify-pending-payments"))).json()
const order = (id: string, o: Record<string, any> = {}) => ({
  id, reference_code: `ORD-${id}`, network: "MTN", customer_phone: "0241234567", volume_gb: "1", customer_name: "A",
  total_price: 10, payment_status: "pending", order_status: "pending", created_at: "2026-11-04T09:00:00Z", ...o,
})
const paystackCalls = () => h.fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("api.paystack.co"))

beforeEach(() => {
  for (const k of Object.keys(h.tables)) delete h.tables[k]
  for (const k of Object.keys(h.errors)) delete h.errors[k]
  for (const k of Object.keys(h.paystack)) delete h.paystack[k]
  h.updates.length = 0
  h.fetchMock.mockClear()
  vi.stubGlobal("fetch", h.fetchMock)
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("verify-pending-payments cron and Hubtel rows", () => {
  it("a wallet payment with payment_method hubtel is never sent to Paystack and its order is untouched", async () => {
    h.tables.shop_orders = [order("o1")]
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-H", payment_method: "hubtel", created_at: "2026-11-04T09:00:00Z" }]

    const out = await run()

    expect(paystackCalls()).toEqual([])
    expect(h.updates).toEqual([])
    expect(h.tables.shop_orders[0].payment_status).toBe("pending")
    expect(out.results).toEqual([{ id: "o1", reference: "WALLET-H", paystack_status: "skipped", action: "hubtel_payment" }])
    expect(out.stillPending).toBe(1)
  })

  it("a live hubtel_payments row for the wallet reference also skips Paystack (payment_method not set)", async () => {
    h.tables.shop_orders = [order("o1")]
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-H", payment_method: "paystack", created_at: "2026-11-04T09:00:00Z" }]
    h.tables.hubtel_payments = [{ reference: "a".repeat(32), internal_reference: "WALLET-H", status: "needs_review", amount_pesewas: 1000, created_at: "2026-11-04T09:00:00Z" }]

    await run()

    expect(paystackCalls()).toEqual([])
    expect(h.tables.shop_orders[0].payment_status).toBe("pending")
  })

  it("a Paystack row Paystack has never heard of is still marked abandoned, as before", async () => {
    h.tables.shop_orders = [order("o1")]
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-P", payment_method: "paystack", created_at: "2026-11-04T09:00:00Z" }]
    // An old failed Hubtel attempt for the same reference does not make it Hubtel's.
    h.tables.hubtel_payments = [{ reference: "b".repeat(32), internal_reference: "WALLET-P", status: "failed", amount_pesewas: 1000, created_at: "2026-11-04T08:00:00Z" }]

    const out = await run()

    expect(paystackCalls()).toEqual(["https://api.paystack.co/transaction/verify/WALLET-P"])
    expect(h.tables.shop_orders[0].payment_status).toBe("abandoned")
    expect(out.results[0]).toMatchObject({ action: "marked_abandoned" })
  })

  it("a Paystack success still completes the order and triggers fulfilment", async () => {
    h.tables.shop_orders = [order("o1")]
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-P", payment_method: null, created_at: "2026-11-04T09:00:00Z" }]
    h.paystack["WALLET-P"] = { status: 200, body: { status: true, data: { status: "success", amount: 1000 } } }

    const out = await run()

    expect(h.tables.shop_orders[0].payment_status).toBe("completed")
    expect(out.results[0]).toMatchObject({ action: "verified_and_updated", fulfillment: "triggered" })
  })

  it("no hubtel_payments table yet (migration unapplied) behaves exactly as before", async () => {
    h.tables.shop_orders = [order("o1")]
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-P", created_at: "2026-11-04T09:00:00Z" }]
    h.errors.hubtel_payments = { code: "PGRST205", message: "Could not find the table" }

    const out = await run()

    expect(h.tables.shop_orders[0].payment_status).toBe("abandoned")
    expect(out.results[0]).toMatchObject({ action: "marked_abandoned" })
  })

  it("a failing Hubtel lookup stops the run before any order is changed", async () => {
    h.tables.shop_orders = [order("o1")]
    h.tables.wallet_payments = [{ order_id: "o1", reference: "WALLET-P", created_at: "2026-11-04T09:00:00Z" }]
    h.errors.hubtel_payments = { code: "57014", message: "statement timeout" }

    const res = await GET(new NextRequest("http://x/api/cron/verify-pending-payments"))

    expect(res.status).toBe(500)
    expect(paystackCalls()).toEqual([])
    expect(h.tables.shop_orders[0].payment_status).toBe("pending")
  })
})
