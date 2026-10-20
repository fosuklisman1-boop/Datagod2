// Paystack webhook, charge.failed for a commission (cs_bill / cs_bundle) payment:
// - a channel 'bots' order is failed right away with the guarded bot patch (only pending + unpaid + bots), so it stops
//   counting against the engine's pending caps (the stale sweep would otherwise take up to ~40 min);
// - a storefront order is left exactly as today;
// - the wallet_payments row is failed only while still pending (a completed payment is never flipped to failed).
import { beforeEach, describe, expect, it, vi } from "vitest"
import crypto from "crypto"

const h = vi.hoisted(() => {
  process.env.PAYSTACK_SECRET_KEY = "test-paystack-secret"
  type Row = Record<string, any>
  const tables: Record<string, Row[]> = {}
  /** In-memory, filter-aware PostgREST fake (eq / in / neq; update applies on await; maybeSingle / single). */
  const fake = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = []
      let patch: Row | null = null
      const rows = () => (tables[table] ?? []).filter(r => filters.every(f => f(r)))
      const q: any = {
        select: () => q, order: () => q, limit: () => q, gte: () => q, lte: () => q, is: () => q, or: () => q,
        eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return q },
        neq: (c: string, v: unknown) => { filters.push(r => r[c] !== v); return q },
        in: (c: string, vs: unknown[]) => { filters.push(r => vs.includes(r[c])); return q },
        update: (p: Row) => { patch = p; return q },
        insert: () => q,
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        single: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok: any, ko: any) => {
          const hit = rows()
          if (patch) for (const r of hit) Object.assign(r, patch)
          return Promise.resolve({ data: hit.map(r => ({ id: r.id })), error: null }).then(ok, ko)
        },
      }
      return q
    },
    rpc: async () => ({ data: null, error: null }),
  }
  return { tables, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: vi.fn(async () => {}),
  notifyAdmins: vi.fn(async () => {}),
  SMSTemplates: new Proxy({}, { get: () => () => "msg" }),
}))
vi.mock("@/lib/app-settings", () => ({ getJoinCommunityLink: vi.fn(async () => null) }))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async () => {}) }))
vi.mock("@/lib/internal-url", () => ({ getInternalBaseUrl: () => "http://localhost" }))
vi.mock("@/lib/results-checker-service", () => ({ notifyAdminsNewResultsCheckRequest: vi.fn(async () => {}) }))
vi.mock("@/lib/admin-actions/withdrawal-hook", () => ({ notifyWithdrawalCompleted: vi.fn(async () => {}) }))
vi.mock("@/lib/customer-tracking-service", () => ({ customerTrackingService: { trackCustomer: vi.fn(async () => {}) } }))

import { NextRequest } from "next/server"
import { POST } from "./route"

const REF = "f".repeat(32)

function chargeFailed() {
  const body = JSON.stringify({ event: "charge.failed", data: { id: 9, reference: REF, status: "failed", gateway_response: "Declined" } })
  const sig = crypto.createHmac("sha512", "test-paystack-secret").update(body).digest("hex")
  return POST(new NextRequest("http://x/api/webhooks/paystack", { method: "POST", body, headers: { "x-paystack-signature": sig } }))
}

const order = (id: string, over: Record<string, any> = {}) => ({
  id, channel: "bots", bot_surface: "ussd", status: "pending", payment_status: "unpaid", failure_reason: null, ...over,
})
const payment = (orderId: string, orderType: string, over: Record<string, any> = {}) => ({
  id: "wp1", reference: REF, order_id: orderId, order_type: orderType, status: "pending", ...over,
})

beforeEach(() => {
  for (const k of Object.keys(h.tables)) delete h.tables[k]
})

describe("Paystack charge.failed for a commission payment", () => {
  it("bots bill order: failed with the guarded bot patch; payment failed", async () => {
    h.tables.hubtel_bill_orders = [order("b1")]
    h.tables.wallet_payments = [payment("b1", "cs_bill")]
    await chargeFailed()
    expect(h.tables.hubtel_bill_orders[0]).toMatchObject({ status: "failed", failure_reason: "payment not completed", payment_status: "unpaid" })
    expect(h.tables.wallet_payments[0].status).toBe("failed")
  })

  it("bots bundle order (shop USSD): failed the same way", async () => {
    h.tables.hubtel_data_orders = [order("d1", { bot_surface: "ussd_shop" })]
    h.tables.wallet_payments = [payment("d1", "cs_bundle")]
    await chargeFailed()
    expect(h.tables.hubtel_data_orders[0]).toMatchObject({ status: "failed", failure_reason: "payment not completed" })
  })

  it("storefront order: left exactly as today (only the payment row is failed)", async () => {
    const sf = order("b1", { channel: "storefront", bot_surface: null })
    h.tables.hubtel_bill_orders = [{ ...sf }]
    h.tables.wallet_payments = [payment("b1", "cs_bill")]
    await chargeFailed()
    expect(h.tables.hubtel_bill_orders[0]).toEqual(sf)
    expect(h.tables.wallet_payments[0].status).toBe("failed")
  })

  it("a paid (or no longer pending) bots order is never touched", async () => {
    const paid = order("b1", { payment_status: "paid" })
    const done = order("d1", { status: "completed" })
    h.tables.hubtel_bill_orders = [{ ...paid }]
    h.tables.hubtel_data_orders = [{ ...done }]
    h.tables.wallet_payments = [payment("b1", "cs_bill")]
    await chargeFailed()
    expect(h.tables.hubtel_bill_orders[0]).toEqual(paid)
    expect(h.tables.hubtel_data_orders[0]).toEqual(done)
  })

  it("status guard: a completed payment row is never flipped to failed (and its order is left alone)", async () => {
    const paid = order("b1", { payment_status: "paid" })
    h.tables.hubtel_bill_orders = [{ ...paid }]
    h.tables.wallet_payments = [payment("b1", "cs_bill", { status: "completed" })]
    await chargeFailed()
    expect(h.tables.wallet_payments[0].status).toBe("completed")
    expect(h.tables.hubtel_bill_orders[0]).toEqual(paid)
  })
})
