// /api/payments/verify: a Hubtel payment is confirmed through confirmHubtelPayment (looked up by internal_reference)
// and reported from the row; it never reaches Paystack's verify, including the storefront path. Paystack rows behave
// as before.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => {
  type Row = Record<string, any>
  const tables: Record<string, Row[]> = {}
  const updates: { table: string; patch: Row }[] = []
  const fake: any = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = []
      let patch: Row | null = null
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      const q: any = {
        select: () => q, order: () => q, limit: () => q,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
        update: (p: Row) => ((patch = p), q),
        insert: async () => ({ data: null, error: null }),
        single: async () => ({ data: rows()[0] ?? null, error: rows()[0] ? null : { message: "none" } }),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok: any, ko: any) => {
          const hit = rows()
          if (patch) { updates.push({ table, patch }); for (const r of hit) Object.assign(r, patch) }
          return Promise.resolve({ data: hit, error: null }).then(ok, ko)
        },
      }
      return q
    },
    rpc: vi.fn(async () => ({ data: null, error: null })),
  }
  return {
    tables, updates, fake,
    verifyPayment: vi.fn(async (ref: string) => ({ status: "abandoned", amount: 0, reference: ref, transaction_id: null as any })),
    verifyStorefront: vi.fn(async () => ({ httpStatus: 200, body: { success: true, status: "abandoned" } })),
    confirm: vi.fn(async (_ref: string) => "pending"),
    fetchMock: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/paystack", () => ({ verifyPayment: (r: string) => h.verifyPayment(r) }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(async () => {}), SMSTemplates: new Proxy({}, { get: () => () => "msg" }), networkColor: (n: string) => n, notifyAdmins: vi.fn(async () => {}) }))
vi.mock("@/lib/at-ishare-service", () => ({ atishareService: {} }))
vi.mock("@/lib/blacklist", () => ({ isPhoneBlacklisted: vi.fn(async () => false) }))
vi.mock("@/lib/storefront-commission/confirm-runtime", () => ({ verifyStorefrontPaymentRoute: (...a: any[]) => (h.verifyStorefront as any)(...a) }))
vi.mock("@/lib/hubtel-pay/confirm", () => ({ confirmHubtelPayment: (r: string) => h.confirm(r) }))

import { POST } from "./route"

const HREF = "e".repeat(32)
const verify = async (reference: string) => {
  const res = await POST(new NextRequest("http://x/api/payments/verify", { method: "POST", body: JSON.stringify({ reference }) }))
  return { status: res.status, body: await res.json() }
}
const wp = (o: Record<string, any> = {}) => ({
  id: "wp1", user_id: "u1", reference: "WALLET-1", status: "pending", shop_id: null, order_id: null, order_type: "wallet_topup",
  amount: 10, payment_method: "paystack", ...o,
})
const hrow = (o: Record<string, any> = {}) => ({
  reference: HREF, internal_reference: "WALLET-1", status: "pending", amount_pesewas: 1000, created_at: "2026-11-04T09:00:00Z", ...o,
})

beforeEach(() => {
  for (const k of Object.keys(h.tables)) delete h.tables[k]
  h.updates.length = 0
  h.verifyPayment.mockClear()
  h.verifyStorefront.mockClear()
  h.confirm.mockReset()
  h.fetchMock.mockClear()
  vi.stubGlobal("fetch", h.fetchMock)
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("POST /api/payments/verify, Hubtel rows", () => {
  it("confirms through Hubtel and reports success from the row; Paystack never asked; route writes nothing", async () => {
    h.tables.wallet_payments = [wp({ payment_method: "hubtel" })]
    h.tables.hubtel_payments = [hrow()]
    h.confirm.mockImplementation(async () => { h.tables.hubtel_payments[0].status = "paid"; return "fulfilled" })

    const out = await verify("WALLET-1")

    expect(h.confirm).toHaveBeenCalledWith(HREF)
    expect(h.verifyPayment).not.toHaveBeenCalled()
    expect(out).toEqual({ status: 200, body: { success: true, status: "success", amount: 10, reference: "WALLET-1", message: "Payment verified! Wallet will be credited shortly." } })
    expect(h.updates).toEqual([])
    expect(h.fetchMock).not.toHaveBeenCalled()
  })

  it("an unpaid Hubtel payment is pending, a failed one failed, a held one pending (under review)", async () => {
    h.tables.wallet_payments = [wp({ payment_method: "hubtel" })]
    h.tables.hubtel_payments = [hrow()]
    h.confirm.mockImplementation(async () => "pending")
    expect((await verify("WALLET-1")).body).toMatchObject({ success: true, status: "pending" })

    h.tables.hubtel_payments[0].status = "failed"
    h.confirm.mockImplementation(async () => "ignored")
    expect((await verify("WALLET-1")).body).toMatchObject({ success: true, status: "failed" })

    h.tables.hubtel_payments[0].status = "needs_review"
    expect((await verify("WALLET-1")).body).toMatchObject({ success: true, status: "pending", message: "Payment received; it is being reviewed" })
    expect(h.verifyPayment).not.toHaveBeenCalled()
    expect(h.tables.wallet_payments[0].status).toBe("pending")
  })

  it("the storefront path: a Hubtel cs_bundle payment never reaches the Paystack storefront verifier", async () => {
    h.tables.wallet_payments = [wp({ payment_method: "hubtel", order_type: "cs_bundle", order_id: "d1" })]
    h.tables.hubtel_payments = [hrow({ status: "paid" })]
    h.confirm.mockImplementation(async () => "ignored")

    const out = await verify("WALLET-1")

    expect(h.verifyStorefront).not.toHaveBeenCalled()
    expect(h.verifyPayment).not.toHaveBeenCalled()
    expect(out.body).toMatchObject({ success: true, status: "success", message: "Payment verified!" })
  })

  it("a live Hubtel row alone (payment_method not set) is enough", async () => {
    h.tables.wallet_payments = [wp({ payment_method: null })]
    h.tables.hubtel_payments = [hrow({ status: "confirming" })]
    h.confirm.mockImplementation(async () => "ignored")
    expect((await verify("WALLET-1")).body).toMatchObject({ status: "pending" })
    expect(h.verifyPayment).not.toHaveBeenCalled()
  })

  it("payment_method hubtel with no Hubtel row: pending, Paystack never asked", async () => {
    h.tables.wallet_payments = [wp({ payment_method: "hubtel" })]
    expect((await verify("WALLET-1")).body).toEqual({ success: true, status: "pending", reference: "WALLET-1", message: "Payment pending" })
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.verifyPayment).not.toHaveBeenCalled()
  })

  it("an already completed Hubtel wallet payment answers as before", async () => {
    h.tables.wallet_payments = [wp({ payment_method: "hubtel", status: "completed" })]
    h.tables.hubtel_payments = [hrow({ status: "paid" })]
    expect((await verify("WALLET-1")).body).toEqual({ success: true, status: "completed", message: "Payment already verified and completed" })
    expect(h.confirm).not.toHaveBeenCalled()
  })
})

describe("POST /api/payments/verify, Paystack rows unchanged", () => {
  it("an abandoned Paystack payment is written as before", async () => {
    h.tables.wallet_payments = [wp()]
    h.tables.hubtel_payments = [hrow({ status: "failed" })] // a closed Hubtel attempt does not make it Hubtel's

    const out = await verify("WALLET-1")

    expect(h.verifyPayment).toHaveBeenCalledWith("WALLET-1")
    expect(h.confirm).not.toHaveBeenCalled()
    expect(out.body).toMatchObject({ success: true, status: "abandoned" })
    expect(h.tables.wallet_payments[0].status).toBe("abandoned")
  })

  it("the Paystack storefront path is still used for a Paystack cs_bill payment", async () => {
    h.tables.wallet_payments = [wp({ order_type: "cs_bill", order_id: "b1" })]
    const out = await verify("WALLET-1")
    expect(h.verifyStorefront).toHaveBeenCalledTimes(1)
    expect(out.body).toEqual({ success: true, status: "abandoned" })
  })
})
