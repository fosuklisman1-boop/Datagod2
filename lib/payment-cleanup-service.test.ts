// The Paystack cleanup/verify helpers must leave Hubtel wallet payments alone (Paystack answers 404 for references it
// never saw, which these read as "abandoned"/"failed"), and behave as before for Paystack rows.
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://sb"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "srk"
  type Row = Record<string, any>
  const tables: Record<string, Row[]> = {}
  const errors: Record<string, { code?: string; message: string }> = {}
  const fake: any = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = []
      let patch: Row | null = null
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      const q: any = {
        select: () => q, order: () => q, limit: () => q, lt: () => q, gt: () => q, is: () => q, neq: () => q,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
        update: (p: Row) => ((patch = p), q),
        insert: async () => ({ data: null, error: null }),
        single: async () => ({ data: rows()[0] ?? null, error: null }),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok: any, ko: any) => {
          if (errors[table]) return Promise.resolve({ data: null, error: errors[table] }).then(ok, ko)
          const hit = rows()
          if (patch) for (const r of hit) Object.assign(r, patch)
          return Promise.resolve({ data: hit, error: null }).then(ok, ko)
        },
      }
      return q
    },
    rpc: vi.fn(async () => ({ data: [{ new_balance: 10, already_processed: false }], error: null })),
  }
  const paystack: Record<string, { status: number; body: any }> = {}
  const fetchMock = vi.fn(async (url: string) => {
    const ref = decodeURIComponent(String(url).split("/transaction/verify/")[1] ?? "")
    const r = paystack[ref] ?? { status: 404, body: { status: false, message: "Transaction reference not found" } }
    return new Response(JSON.stringify(r.body), { status: r.status })
  })
  return { tables, errors, fake, paystack, fetchMock }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(async () => {}), SMSTemplates: new Proxy({}, { get: () => () => "msg" }) }))
vi.mock("@/lib/notification-service", () => ({ notificationTemplates: { balanceUpdated: () => ({ title: "t", message: "m", type: "x" }) } }))
vi.mock("./push-service", () => ({ sendPushToUser: vi.fn(async () => {}) }))

import { cleanupAbandonedPayments, verifyUserPaymentByReference, verifyUserPendingPayments } from "./payment-cleanup-service"

const paystackCalls = () => h.fetchMock.mock.calls.map((c) => String(c[0]))
const wp = (o: Record<string, any> = {}) => ({
  id: "wp1", reference: "WALLET-1", user_id: "u1", amount: 10, fee: 0, status: "pending", shop_id: null, order_id: null,
  order_type: "wallet_topup", payment_method: "paystack", created_at: "2026-11-04T09:00:00Z", ...o,
})
const hubtelRow = (o: Record<string, any> = {}) => ({
  reference: "a".repeat(32), internal_reference: "WALLET-1", status: "pending", amount_pesewas: 1000, created_at: "2026-11-04T09:00:00Z", ...o,
})

beforeEach(() => {
  for (const k of Object.keys(h.tables)) delete h.tables[k]
  for (const k of Object.keys(h.errors)) delete h.errors[k]
  for (const k of Object.keys(h.paystack)) delete h.paystack[k]
  h.fetchMock.mockClear()
  h.fake.rpc.mockClear()
  vi.stubGlobal("fetch", h.fetchMock)
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("cleanupAbandonedPayments", () => {
  it("a Hubtel wallet payment (payment_method hubtel) is not sent to Paystack and stays pending", async () => {
    h.tables.wallet_payments = [wp({ payment_method: "hubtel", shop_id: "s1", order_id: "o1" })]
    h.tables.shop_orders = [{ id: "o1", payment_status: "pending" }]
    expect(await cleanupAbandonedPayments(30)).toEqual({ cleaned: 0, verified: 0, credited: 0 })
    expect(paystackCalls()).toEqual([])
    expect(h.tables.wallet_payments[0].status).toBe("pending")
    expect(h.tables.shop_orders[0].payment_status).toBe("pending")
  })

  it("a live hubtel_payments row for the reference also keeps it away from Paystack", async () => {
    h.tables.wallet_payments = [wp()]
    h.tables.hubtel_payments = [hubtelRow({ status: "confirming" })]
    await cleanupAbandonedPayments(30)
    expect(paystackCalls()).toEqual([])
    expect(h.tables.wallet_payments[0].status).toBe("pending")
  })

  it("a Paystack row Paystack never heard of is marked abandoned, as before", async () => {
    h.tables.wallet_payments = [wp()]
    expect(await cleanupAbandonedPayments(30)).toEqual({ cleaned: 1, verified: 0, credited: 0 })
    expect(paystackCalls()).toEqual(["https://api.paystack.co/transaction/verify/WALLET-1"])
    expect(h.tables.wallet_payments[0].status).toBe("abandoned")
  })

  it("no hubtel_payments table yet: unchanged", async () => {
    h.tables.wallet_payments = [wp()]
    h.errors.hubtel_payments = { code: "42P01", message: "relation does not exist" }
    expect(await cleanupAbandonedPayments(30)).toEqual({ cleaned: 1, verified: 0, credited: 0 })
  })

  it("a failing Hubtel lookup throws before anything is changed", async () => {
    h.tables.wallet_payments = [wp()]
    h.errors.hubtel_payments = { code: "57014", message: "timeout" }
    await expect(cleanupAbandonedPayments(30)).rejects.toThrow()
    expect(paystackCalls()).toEqual([])
    expect(h.tables.wallet_payments[0].status).toBe("pending")
  })
})

describe("verifyUserPendingPayments", () => {
  it("skips a Hubtel payment", async () => {
    h.tables.wallet_payments = [wp({ payment_method: "hubtel" })]
    h.paystack["WALLET-1"] = { status: 200, body: { status: true, data: { status: "failed" } } }
    expect(await verifyUserPendingPayments("u1")).toEqual({ checked: 0, credited: 0, failed: 0 })
    expect(paystackCalls()).toEqual([])
    expect(h.tables.wallet_payments[0].status).toBe("pending")
  })

  it("a Paystack failure is still recorded, as before", async () => {
    h.tables.wallet_payments = [wp()]
    h.paystack["WALLET-1"] = { status: 200, body: { status: true, data: { status: "failed" } } }
    expect(await verifyUserPendingPayments("u1")).toEqual({ checked: 1, credited: 0, failed: 1 })
    expect(h.tables.wallet_payments[0].status).toBe("failed")
  })

  it("a failing Hubtel lookup checks nothing", async () => {
    h.tables.wallet_payments = [wp()]
    h.errors.hubtel_payments = { code: "57014", message: "timeout" }
    expect(await verifyUserPendingPayments("u1")).toEqual({ checked: 0, credited: 0, failed: 0 })
    expect(paystackCalls()).toEqual([])
  })
})

describe("verifyUserPaymentByReference", () => {
  it("a pending Hubtel payment is reported pending, never failed through Paystack's 404", async () => {
    h.tables.wallet_payments = [wp({ payment_method: "hubtel" })]
    expect(await verifyUserPaymentByReference("u1", "WALLET-1")).toEqual({ outcome: "pending" })
    expect(paystackCalls()).toEqual([])
    expect(h.tables.wallet_payments[0].status).toBe("pending")
    expect(h.fake.rpc).not.toHaveBeenCalled()
  })

  it("a Hubtel payment reports from its wallet row (credited by the shared handler)", async () => {
    h.tables.wallet_payments = [wp({ payment_method: "hubtel", status: "completed" })]
    expect(await verifyUserPaymentByReference("u1", "WALLET-1")).toEqual({ outcome: "already_credited" })
    h.tables.wallet_payments = [wp({ status: "failed" })]
    h.tables.hubtel_payments = [hubtelRow({ status: "needs_review" })]
    expect(await verifyUserPaymentByReference("u1", "WALLET-1")).toEqual({ outcome: "pending" })
    expect(paystackCalls()).toEqual([])
  })

  it("a Paystack 404 still marks a Paystack row failed, as before", async () => {
    h.tables.wallet_payments = [wp()]
    expect(await verifyUserPaymentByReference("u1", "WALLET-1")).toEqual({ outcome: "failed" })
    expect(h.tables.wallet_payments[0].status).toBe("failed")
  })
})
