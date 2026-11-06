// Plan 4 Task 3 corrections to the shared charge handler (lib/payments/charge-events.ts):
// - neutral wording and no Paystack transaction-id columns when metadata.gateway === "hubtel" (Paystack unchanged);
// - order_closed on 2xx answers where nothing was delivered (storefront outcomes, wallet_payments order paths);
// - a failed-charge event never fails a paid USSD order.
// (The credit_wallet_safely rpcError -> 500 change is pinned in charge-events.characterization.test.ts.)
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => {
  type Row = Record<string, any>
  const tables: Record<string, Row[]> = {}
  const fake: any = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = []
      let patch: Row | null = null
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      const q: any = {
        select: () => q, order: () => q, limit: () => q, gte: () => q, lte: () => q, is: () => q, or: () => q,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
        update: (p: Row) => ((patch = p), q),
        insert: () => q,
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        single: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok: any, ko: any) => {
          const hit = rows()
          if (patch) for (const r of hit) Object.assign(r, patch)
          return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(ok, ko)
        },
      }
      return q
    },
    rpc: vi.fn(async (_n: string, _a?: any) => ({ data: [{ new_balance: 110, already_processed: false }] as any, error: null as any })),
    auth: { admin: { updateUserById: async () => ({ data: null, error: null }) } },
  }
  return {
    tables, fake,
    markAirtimeOrderPaid: vi.fn(async (..._a: any[]) => ({ success: true })),
    settle: vi.fn(async (..._a: any[]) => ({ outcome: "confirmed", status: "processing" }) as any),
    notifyAdmins: vi.fn(async () => {}),
    fetchMock: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })),
  }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(async () => {}), notifyAdmins: h.notifyAdmins, SMSTemplates: new Proxy({}, { get: () => () => "msg" }) }))
vi.mock("@/lib/app-settings", () => ({ getJoinCommunityLink: vi.fn(async () => null) }))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async () => {}), notifyAdminsPush: vi.fn(async () => {}) }))
vi.mock("@/lib/internal-url", () => ({ getInternalBaseUrl: () => "http://localhost" }))
vi.mock("@/lib/results-checker-service", () => ({ notifyAdminsNewResultsCheckRequest: vi.fn(async () => {}) }))
vi.mock("@/lib/airtime-service", () => ({ markAirtimeOrderPaid: h.markAirtimeOrderPaid }))
vi.mock("@/lib/customer-tracking-service", () => ({ customerTrackingService: { trackCustomer: vi.fn(async () => ({ customerId: null })) } }))
vi.mock("@/lib/security-log", () => ({ logSecurityEvent: vi.fn() }))
vi.mock("@/lib/storefront-commission/confirm-runtime", () => ({ settleStorefrontWebhook: (...a: any[]) => h.settle(...a) }))

import { handleChargeFailed, handleChargeSuccess } from "@/lib/payments/charge-events"

const REF = "WALLET-1"
const HUBTEL = { gateway: "hubtel" }
const charge = (o: Record<string, any> = {}) => ({ reference: REF, amount: 10300, id: "9f8e7d6c5b4a", gateway_response: "Hubtel: Paid", ...o })
const answer = async (o: Record<string, any> = {}) => {
  const res = await handleChargeSuccess(charge(o))
  return res ? { status: res.status, body: await res.json() } : null
}
const wp = (o: Record<string, any> = {}) => ({
  id: "wp1", reference: REF, user_id: "u1", order_id: null, shop_id: null, order_type: "wallet_topup", amount: 103, fee: 3, status: "pending", ...o,
})
const CLOSED = { status: 200, body: { received: true, order_closed: true } }

beforeEach(() => {
  for (const k of Object.keys(h.tables)) delete h.tables[k]
  h.fake.rpc.mockClear()
  h.markAirtimeOrderPaid.mockReset()
  h.markAirtimeOrderPaid.mockImplementation(async () => ({ success: true }))
  h.settle.mockReset()
  h.notifyAdmins.mockClear()
  h.fetchMock.mockClear()
  vi.stubGlobal("fetch", h.fetchMock)
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("wording", () => {
  it("a Hubtel wallet top-up is described without naming a gateway", async () => {
    h.tables.wallet_payments = [wp()]
    h.tables.users = [{ id: "u1", phone_number: null }]
    await answer({ metadata: HUBTEL })
    expect(h.fake.rpc).toHaveBeenCalledWith("credit_wallet_safely", expect.objectContaining({ p_description: "Wallet top-up" }))
  })
  it("a Paystack wallet top-up keeps 'via Paystack'", async () => {
    h.tables.wallet_payments = [wp()]
    h.tables.users = [{ id: "u1", phone_number: null }]
    await answer({ id: 9, metadata: {} })
    expect(h.fake.rpc).toHaveBeenCalledWith("credit_wallet_safely", expect.objectContaining({ p_description: "Wallet top-up via Paystack" }))
  })
})

describe("transaction id columns", () => {
  it("Hubtel: the hex id is never written to paystack_transaction_id or transaction_id", async () => {
    h.tables.shop_orders = [{ id: "so1", payment_status: "pending", total_price: 100, network: "MTN", volume_gb: "1", customer_phone: "0241234567", shop_id: "s1", profit_amount: 0 }]
    h.tables.wallet_payments = [wp({ order_id: "so1", shop_id: "s1", order_type: "shop_order" })]
    h.tables.payment_attempts = [{ reference: REF, status: "pending" }]
    await answer({ metadata: HUBTEL })
    expect(h.tables.wallet_payments[0].status).toBe("completed")
    expect("paystack_transaction_id" in h.tables.wallet_payments[0]).toBe(false)
    expect("paystack_transaction_id" in h.tables.payment_attempts[0]).toBe(false)
    expect(h.tables.shop_orders[0].payment_status).toBe("completed")
    expect("transaction_id" in h.tables.shop_orders[0]).toBe(false)
  })
  it("Paystack: ids written as before", async () => {
    h.tables.shop_orders = [{ id: "so1", payment_status: "pending", total_price: 100, network: "MTN", volume_gb: "1", customer_phone: "0241234567", shop_id: "s1", profit_amount: 0 }]
    h.tables.wallet_payments = [wp({ order_id: "so1", shop_id: "s1", order_type: "shop_order" })]
    h.tables.payment_attempts = [{ reference: REF, status: "pending" }]
    await answer({ id: 9 })
    expect(h.tables.wallet_payments[0].paystack_transaction_id).toBe(9)
    expect(h.tables.payment_attempts[0].paystack_transaction_id).toBe(9)
    expect(h.tables.shop_orders[0].transaction_id).toBe(9)
  })
  it("Hubtel airtime (wallet_payments and USSD paths) is marked paid without the id; Paystack passes it", async () => {
    h.tables.wallet_payments = [wp({ order_id: "a1", order_type: "airtime" })]
    h.tables.airtime_orders = [{ id: "a1", total_paid: 100 }]
    await answer({ metadata: HUBTEL })
    expect(h.markAirtimeOrderPaid).toHaveBeenLastCalledWith("a1", null)
    await answer({ id: 9 })
    expect(h.markAirtimeOrderPaid).toHaveBeenLastCalledWith("a1", 9)

    for (const k of Object.keys(h.tables)) delete h.tables[k]
    const USSD = "7f6c1f0e-1111-4222-8333-944455556666"
    h.tables.airtime_orders = [{ id: USSD, payment_status: "pending", total_paid: 10, airtime_amount: 10, network: "MTN", beneficiary_phone: "0241234567", dialing_phone: "0241234567" }]
    await answer({ reference: USSD, amount: 1000, metadata: HUBTEL })
    expect(h.markAirtimeOrderPaid).toHaveBeenLastCalledWith(USSD, null)
  })
  it("Hubtel storefront settle gets no transaction id; Paystack's is passed", async () => {
    h.tables.wallet_payments = [wp({ order_id: "d1", order_type: "cs_bundle" })]
    h.settle.mockResolvedValue({ outcome: "confirmed", status: "processing" })
    await answer({ metadata: HUBTEL })
    expect(h.settle.mock.calls[0][1]).toMatchObject({ transactionId: null })
    await answer({ id: 9 })
    expect(h.settle.mock.calls[1][1]).toMatchObject({ transactionId: "9" })
  })
})

describe("order_closed where nothing was delivered", () => {
  describe("storefront outcomes", () => {
    beforeEach(() => { h.tables.wallet_payments = [wp({ order_id: "d1", order_type: "cs_bundle" })] })
    const settled = (r: Record<string, unknown>) => h.settle.mockResolvedValue(r)

    it("confirmed and sent → exactly {received:true}", async () => {
      settled({ outcome: "confirmed", status: "processing" })
      expect(await answer()).toEqual({ status: 200, body: { received: true } })
    })
    it("resumed → {received:true}", async () => {
      settled({ outcome: "resumed", status: "processing" })
      expect(await answer()).toEqual({ status: 200, body: { received: true } })
    })
    it.each(["failed", "expired", "cancelled"])("confirmed on an order already %s (not sent, refund) → order_closed", async (status) => {
      settled({ outcome: "confirmed", status })
      expect(await answer()).toEqual(CLOSED)
    })
    it.each(["refused", "amount_mismatch"])("%s → order_closed (still 200)", async (outcome) => {
      settled({ outcome })
      expect(await answer()).toEqual(CLOSED)
    })
    it("already_processed by THIS payment (a replay) → {received:true}", async () => {
      settled({ outcome: "already_processed", status: "completed" })
      h.tables.hubtel_data_orders = [{ id: "d1", payment_status: "paid", payment_reference: REF, status: "completed" }]
      expect(await answer()).toEqual({ status: 200, body: { received: true } })
    })
    it("already_processed because ANOTHER payment paid it (a duplicate) → order_closed", async () => {
      settled({ outcome: "already_processed", status: "completed" })
      h.tables.hubtel_data_orders = [{ id: "d1", payment_status: "paid", payment_reference: "WALLET-OTHER", status: "completed" }]
      expect(await answer()).toEqual(CLOSED)
    })
    it("already_processed and the order cannot be re-read → order_closed (review, never paid blind)", async () => {
      settled({ outcome: "already_processed", status: "pending" })
      expect(await answer()).toEqual(CLOSED)
    })
    it("error → 500 as before", async () => {
      settled({ outcome: "error" })
      expect((await answer())?.status).toBe(500)
    })
  })

  it("a wallet top-up with no user → order_closed, nothing credited", async () => {
    h.tables.wallet_payments = [wp({ user_id: null })]
    expect(await answer()).toEqual(CLOSED)
    expect(h.fake.rpc).not.toHaveBeenCalled()
  })

  it("a shop-token payment whose purchase row is missing → order_closed", async () => {
    h.tables.wallet_payments = [wp({ order_id: "p1", order_type: "ussd_shop_token", amount: 10, fee: 0 })]
    expect(await answer({ amount: 1000 })).toEqual(CLOSED)
  })

  it("a shop-order payment whose order row is missing → order_closed", async () => {
    h.tables.wallet_payments = [wp({ order_id: "gone", order_type: "shop_order" })]
    expect(await answer()).toEqual(CLOSED)
  })

  it("an airtime payment the airtime service could not apply → order_closed", async () => {
    h.tables.wallet_payments = [wp({ order_id: "a1", order_type: "airtime" })]
    h.tables.airtime_orders = [{ id: "a1", total_paid: 100 }]
    h.markAirtimeOrderPaid.mockResolvedValue({ success: false })
    expect(await answer()).toEqual(CLOSED)
  })

  it("an airtime payment applied (or already applied) → no early answer, as before", async () => {
    h.tables.wallet_payments = [wp({ order_id: "a1", order_type: "airtime" })]
    h.tables.airtime_orders = [{ id: "a1", total_paid: 100 }]
    expect(await answer()).toBeNull()
    h.markAirtimeOrderPaid.mockResolvedValue({ success: true, alreadyProcessed: true } as any)
    expect(await answer()).toBeNull()
  })

  it("a refused dealer upgrade → order_closed (still 200, admins alerted)", async () => {
    // attached_to_order: the payment row points at a real order, not the plan
    h.tables.wallet_payments = [wp({ order_type: "dealer_upgrade", order_id: "ord9", amount: 50, fee: 0 })]
    h.tables.subscription_plans = [{ id: "plan1", price: 50, duration_days: 30 }]
    expect(await answer({ amount: 5000, metadata: { type: "dealer_upgrade", planId: "plan1", userId: "u1" } })).toEqual(CLOSED)
    expect(h.notifyAdmins).toHaveBeenCalledTimes(1)
  })

  it("dealer upgrade with no plan or user → order_closed", async () => {
    h.tables.wallet_payments = [wp({ order_type: "dealer_upgrade", order_id: null, user_id: null, amount: 50, fee: 0 })]
    expect(await answer({ amount: 5000 })).toEqual(CLOSED)
  })

  it("a granted dealer upgrade answers as before (no early answer)", async () => {
    h.tables.wallet_payments = [wp({ order_type: "dealer_upgrade", order_id: "plan1", amount: 50, fee: 0 })]
    h.tables.subscription_plans = [{ id: "plan1", price: 50, duration_days: 30 }]
    h.tables.users = [{ id: "u1", phone_number: null }]
    expect(await answer({ amount: 5000 })).toBeNull()
  })

  it("a credited wallet top-up answers as before (no early answer)", async () => {
    h.tables.wallet_payments = [wp()]
    h.tables.users = [{ id: "u1", phone_number: null }]
    expect(await answer()).toBeNull()
  })
})

describe("handleChargeFailed never fails a paid USSD order", () => {
  const ID = "7f6c1f0e-1111-4222-8333-944455556666"
  it.each(["ussd_orders", "ussd_afa_orders", "ussd_shop_orders"])("%s: completed stays completed; pending is failed as before", async (table) => {
    h.tables[table] = [{ id: ID, payment_status: "completed", order_status: "processing" }]
    await handleChargeFailed({ reference: ID, amount: 0, gateway_response: "Hubtel: Unpaid (expired)" })
    expect(h.tables[table][0]).toMatchObject({ payment_status: "completed", order_status: "processing" })

    h.tables[table] = [{ id: ID, payment_status: "pending", order_status: "pending" }]
    await handleChargeFailed({ reference: ID, amount: 0, gateway_response: "Declined" })
    expect(h.tables[table][0]).toMatchObject({ payment_status: "failed", order_status: "failed" })
  })
})

describe("a Hubtel payment on a closed shop order", () => {
  const closed = { id: "so1", order_status: "expired", payment_status: "expired", total_price: 100, network: "MTN", volume_gb: "1", customer_phone: "0241234569", shop_id: "s1", profit_amount: 5 }
  it("answers order_closed before the flip and before profit; the wallet row keeps the proof", async () => {
    h.tables.shop_orders = [{ ...closed }]
    h.tables.wallet_payments = [wp({ order_id: "so1", shop_id: "s1", order_type: "shop_order" })]
    const a = await answer({ metadata: HUBTEL })
    expect(a?.status).toBe(200)
    expect(a?.body).toMatchObject({ received: true, order_closed: true, closed_reason: "late_payment" })
    expect(h.tables.shop_orders[0].payment_status).toBe("expired")
    expect(h.tables.wallet_payments[0].status).toBe("completed")
    expect(h.fetchMock).not.toHaveBeenCalled()
    // Hubtel's confirm path raises its own alert.
    expect(h.notifyAdmins).not.toHaveBeenCalled()
  })
  it("Paystack: the same order alerts admins, with no phone number in the message", async () => {
    h.tables.shop_orders = [{ ...closed }]
    h.tables.wallet_payments = [wp({ order_id: "so1", shop_id: "s1", order_type: "shop_order" })]
    const a = await answer({ id: 9, metadata: {} })
    expect(a?.status).toBe(200)
    expect(h.tables.shop_orders[0].payment_status).toBe("expired")
    const calls = h.notifyAdmins.mock.calls as unknown as string[][]
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toContain("/admin/refunds")
    expect(calls[0][0]).not.toContain(closed.customer_phone)
  })
})
