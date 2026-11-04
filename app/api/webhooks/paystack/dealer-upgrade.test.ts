// Paystack webhook, charge.success for a dealer upgrade: the role and subscription are granted only
// when the amount paid (minus the fee) covers the plan's price. wallet_payments.amount can't be
// trusted for this: an upgrade initialized with an orderId was priced from that order.
import { beforeEach, describe, expect, it, vi } from "vitest"
import crypto from "crypto"

const h = vi.hoisted(() => {
  process.env.PAYSTACK_SECRET_KEY = "test-paystack-secret"
  type Row = Record<string, any>
  const tables: Record<string, Row[]> = {}
  const inserts: { table: string; rows: Row[] }[] = []
  const updateUserById = vi.fn(async () => ({ data: null, error: null }))
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
        insert: (ins: Row[]) => { inserts.push({ table, rows: ins }); return q },
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
    auth: { admin: { updateUserById } },
  }
  const logSecurityEvent = vi.fn()
  const notifyAdmins = vi.fn(async (_message: string, _type: string, _reference?: string) => {})
  const rpc = vi.fn(async () => ({ data: null, error: null }))
  fake.rpc = rpc
  return { tables, inserts, fake, updateUserById, logSecurityEvent, notifyAdmins, rpc }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: vi.fn(async () => {}),
  notifyAdmins: h.notifyAdmins,
  SMSTemplates: new Proxy({}, { get: () => () => "msg" }),
}))
vi.mock("@/lib/app-settings", () => ({ getJoinCommunityLink: vi.fn(async () => null) }))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async () => {}) }))
vi.mock("@/lib/internal-url", () => ({ getInternalBaseUrl: () => "http://localhost" }))
vi.mock("@/lib/results-checker-service", () => ({ notifyAdminsNewResultsCheckRequest: vi.fn(async () => {}) }))
vi.mock("@/lib/admin-actions/withdrawal-hook", () => ({ notifyWithdrawalCompleted: vi.fn(async () => {}) }))
vi.mock("@/lib/customer-tracking-service", () => ({ customerTrackingService: { trackCustomer: vi.fn(async () => {}) } }))
vi.mock("@/lib/security-log", () => ({ logSecurityEvent: h.logSecurityEvent }))

import { NextRequest } from "next/server"
import { POST } from "./route"

const REF = "WALLET-1234567890-abc"
const PLAN = { id: "plan1", name: "3 Days", price: "20.00", duration_days: 3, is_active: true }

function chargeSuccess(amountPesewas: number, metadata: Record<string, unknown>) {
  const body = JSON.stringify({
    event: "charge.success",
    data: { id: 9, reference: REF, status: "success", amount: amountPesewas, metadata, gateway_response: "Successful" },
  })
  const sig = crypto.createHmac("sha512", "test-paystack-secret").update(body).digest("hex")
  return POST(new NextRequest("http://x/api/webhooks/paystack", { method: "POST", body, headers: { "x-paystack-signature": sig } }))
}

const payment = (over: Record<string, any> = {}) => ({
  id: "wp1", reference: REF, user_id: "u1", order_id: null, shop_id: null, order_type: "dealer_upgrade",
  amount: 20.6, fee: 0.6, status: "pending", ...over,
})
const subscriptionInserts = () => h.inserts.filter(i => i.table === "user_subscriptions")

beforeEach(() => {
  for (const k of Object.keys(h.tables)) delete h.tables[k]
  h.inserts.length = 0
  h.updateUserById.mockClear()
  h.logSecurityEvent.mockClear()
  h.notifyAdmins.mockClear()
  h.rpc.mockClear()
  h.tables.subscription_plans = [{ ...PLAN }]
  h.tables.users = [{ id: "u1", role: "user", phone_number: null }]
})

describe("Paystack charge.success for a dealer upgrade", () => {
  it("grants dealer and records the subscription when the plan price is covered", async () => {
    h.tables.wallet_payments = [payment()]
    const res = await chargeSuccess(2060, { type: "dealer_upgrade", planId: "plan1", userId: "u1" })
    expect(res.status).toBe(200)
    expect(h.tables.users[0].role).toBe("dealer")
    expect(subscriptionInserts()).toHaveLength(1)
    expect(subscriptionInserts()[0].rows[0]).toMatchObject({ user_id: "u1", plan_id: "plan1" })
  })

  it("does NOT grant when the payment was priced from a cheap order", async () => {
    h.tables.wallet_payments = [payment({ order_id: "cheap-order", amount: 1.03, fee: 0.03 })]
    const res = await chargeSuccess(103, { type: "dealer_upgrade", planId: "plan1", userId: "u1" })
    expect(res.status).toBe(200) // no retry loop: Paystack re-sending won't change the amount
    expect(h.tables.users[0].role).toBe("user")
    expect(h.updateUserById).not.toHaveBeenCalled()
    expect(subscriptionInserts()).toHaveLength(0)
    expect(h.logSecurityEvent).toHaveBeenCalledWith(
      "dealer_upgrade_refused",
      expect.objectContaining({ reason: "attached_to_order", reference: REF, planId: "plan1", paid: 1.03, planPrice: 20 }),
    )
  })

  it("a refused upgrade alerts admins and credits no wallet", async () => {
    h.tables.wallet_payments = [payment({ amount: 1.03, fee: 0.03 })]
    await chargeSuccess(103, { type: "dealer_upgrade", planId: "plan1", userId: "u1" })
    expect(h.notifyAdmins).toHaveBeenCalledTimes(1)
    expect(h.notifyAdmins.mock.calls[0][2]).toBe(REF)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it("does NOT grant when the payment is attached to an order, even at the full price", async () => {
    h.tables.wallet_payments = [payment({ order_id: "some-order" })]
    await chargeSuccess(2060, { type: "shop_order", planId: "plan1", userId: "u1" })
    expect(h.tables.users[0].role).toBe("user")
    expect(subscriptionInserts()).toHaveLength(0)
    expect(h.notifyAdmins).toHaveBeenCalledTimes(1)
  })

  it("alerts admins when the plan no longer exists, and grants nothing", async () => {
    h.tables.wallet_payments = [payment()]
    await chargeSuccess(2060, { type: "dealer_upgrade", planId: "gone", userId: "u1" })
    expect(h.tables.users[0].role).toBe("user")
    expect(h.notifyAdmins).toHaveBeenCalledTimes(1)
  })

  it("older rows that stored the plan id in order_id still get their upgrade", async () => {
    h.tables.wallet_payments = [payment({ order_id: "plan1" })]
    await chargeSuccess(2060, { type: "dealer_upgrade", userId: "u1" })
    expect(h.tables.users[0].role).toBe("dealer")
  })

  it("does NOT grant when the fee is what makes up the plan price", async () => {
    h.tables.wallet_payments = [payment({ amount: 20, fee: 0.6 })]
    await chargeSuccess(2000, { type: "dealer_upgrade", planId: "plan1", userId: "u1" })
    expect(h.tables.users[0].role).toBe("user")
    expect(subscriptionInserts()).toHaveLength(0)
  })
})
