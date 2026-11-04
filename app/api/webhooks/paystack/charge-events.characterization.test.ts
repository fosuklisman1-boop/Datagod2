// Characterization tests for the Paystack webhook's charge.success / charge.failed handling.
// They pin what the route does TODAY, so the charge handling can move into lib/ unchanged.
// They import only ./route (plus mocks by module path), so they run unchanged after that move.
import { beforeEach, describe, expect, it, vi } from "vitest"
import crypto from "crypto"

const h = vi.hoisted(() => {
  process.env.PAYSTACK_SECRET_KEY = "test-paystack-secret"
  type Row = Record<string, any>
  const tables: Record<string, Row[]> = {}
  const inserts: { table: string; rows: Row[] }[] = []
  const state = { fromCalls: 0, throwOn: null as string | null }
  const fake: any = {
    from(table: string) {
      state.fromCalls++
      if (state.throwOn === table) throw new Error(`boom: ${table}`)
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
    auth: { admin: { updateUserById: async () => ({ data: null, error: null }) } },
  }
  const rpc = vi.fn(async (_name: string, _args?: any) => ({ data: null as any, error: null as any }))
  fake.rpc = rpc
  const sendSMS = vi.fn(async (..._a: any[]) => {})
  const creditUnitsForPaystack = vi.fn(async (..._a: any[]) => ({ ok: true }))
  const fulfillUssdOrder = vi.fn(async (..._a: any[]) => ({ success: true, message: "ok" }))
  const fetchMock = vi.fn(async (..._a: any[]) =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }))
  return { tables, inserts, state, fake, rpc, sendSMS, creditUnitsForPaystack, fulfillUssdOrder, fetchMock }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: h.sendSMS,
  notifyAdmins: vi.fn(async () => {}),
  SMSTemplates: new Proxy({}, { get: () => () => "msg" }),
}))
vi.mock("@/lib/app-settings", () => ({ getJoinCommunityLink: vi.fn(async () => null) }))
vi.mock("@/lib/push-service", () => ({
  sendPushToUser: vi.fn(async () => {}),
  notifyAdminsPush: vi.fn(async () => {}),
}))
vi.mock("@/lib/internal-url", () => ({ getInternalBaseUrl: () => "http://localhost" }))
vi.mock("@/lib/results-checker-service", () => ({ notifyAdminsNewResultsCheckRequest: vi.fn(async () => {}) }))
vi.mock("@/lib/admin-actions/withdrawal-hook", () => ({ notifyWithdrawalCompleted: vi.fn(async () => {}) }))
vi.mock("@/lib/customer-tracking-service", () => ({
  customerTrackingService: { trackCustomer: vi.fn(async () => ({ customerId: null })) },
}))
vi.mock("@/lib/security-log", () => ({ logSecurityEvent: vi.fn() }))
vi.mock("@/lib/sms/bundle-service", () => ({
  creditUnitsForPaystack: h.creditUnitsForPaystack,
  getPricePerCredit: vi.fn(async () => 1),
}))
vi.mock("@/lib/ussd/fulfill", () => ({ fulfillUssdOrder: h.fulfillUssdOrder }))

import { NextRequest } from "next/server"
import { POST } from "./route"

const SECRET = "test-paystack-secret"
const REF = "WALLET-1234567890-abc"
const USSD_ID = "7f6c1f0e-1111-4222-8333-944455556666"

function signed(body: string, secret = SECRET) {
  const sig = crypto.createHmac("sha512", secret).update(body).digest("hex")
  return new NextRequest("http://x/api/webhooks/paystack", { method: "POST", body, headers: { "x-paystack-signature": sig } })
}

function send(event: string, data: Record<string, unknown>) {
  return POST(signed(JSON.stringify({ event, data })))
}

function chargeSuccess(reference: string, amountPesewas: number, metadata: unknown = {}) {
  return send("charge.success", { id: 9, reference, status: "success", amount: amountPesewas, metadata, gateway_response: "Successful" })
}

const payment = (over: Record<string, any> = {}) => ({
  id: "wp1", reference: REF, user_id: "u1", order_id: null, shop_id: null, order_type: "wallet_topup",
  amount: 103, fee: 3, status: "pending", ...over,
})

beforeEach(() => {
  for (const k of Object.keys(h.tables)) delete h.tables[k]
  h.inserts.length = 0
  h.state.fromCalls = 0
  h.state.throwOn = null
  h.rpc.mockReset()
  h.rpc.mockImplementation(async () => ({ data: null, error: null }))
  h.sendSMS.mockClear()
  h.creditUnitsForPaystack.mockClear()
  h.fulfillUssdOrder.mockClear()
  h.fetchMock.mockClear()
  vi.stubGlobal("fetch", h.fetchMock)
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("Paystack charge.success", () => {
  it("wallet top-up credits net of the fee", async () => {
    h.tables.wallet_payments = [payment()]
    h.tables.users = [{ id: "u1", phone_number: null, first_name: "Ama" }]
    h.rpc.mockImplementation(async () => ({ data: [{ new_balance: 100, already_processed: false }], error: null }))

    const res = await chargeSuccess(REF, 10300)

    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(h.rpc).toHaveBeenCalledWith("credit_wallet_safely", expect.objectContaining({
      p_user_id: "u1", p_amount: 100, p_reference_id: REF, p_source: "wallet_topup",
    }))
    expect(h.tables.wallet_payments[0].status).toBe("completed")
    expect(h.tables.wallet_payments[0].amount_received).toBe(103)
  })

  it("a shop order is marked paid", async () => {
    h.tables.shop_orders = [{
      id: "so1", payment_status: "pending", total_price: 100, network: "MTN", volume_gb: "1",
      customer_phone: "0241234567", shop_id: "shop1", profit_amount: 0,
    }]
    h.tables.wallet_payments = [payment({ order_id: "so1", shop_id: "shop1", order_type: "shop_order" })]

    const res = await chargeSuccess(REF, 10300)

    expect(res.status).toBe(200)
    expect(h.tables.shop_orders[0].payment_status).toBe("completed")
    expect(h.tables.shop_orders[0].transaction_id).toBe(9)
    expect(h.tables.wallet_payments[0].status).toBe("completed")
    // Paying an order never credits the wallet.
    expect(h.rpc).not.toHaveBeenCalled()
    // Fulfilment is kicked off through the internal unified endpoint.
    expect(h.fetchMock).toHaveBeenCalledTimes(1)
    expect(String(h.fetchMock.mock.calls[0][0])).toBe("http://localhost/api/fulfillment/process-order")
  })

  it("an underpaid shop order is refused", async () => {
    h.tables.shop_orders = [{ id: "so1", payment_status: "pending", total_price: 100, shop_id: "shop1" }]
    h.tables.wallet_payments = [payment({ order_id: "so1", shop_id: "shop1", order_type: "shop_order" })]

    const res = await chargeSuccess(REF, 5000) // GHS 50 against 100 + 3 fee

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Underpayment" })
    expect(h.tables.wallet_payments[0].status).toBe("pending")
    expect(h.tables.shop_orders[0].payment_status).toBe("pending")
    expect(h.fetchMock).not.toHaveBeenCalled()
  })

  it("metadata sent as a JSON string still routes an sms_bundle payment", async () => {
    h.tables.sms_bundles = [{ id: "b1", units: 250, price_ghs: "10.00" }]
    const metadata = JSON.stringify({ type: "sms_bundle", sms_account_id: "acc1", bundle_id: "b1" })

    const res = await chargeSuccess("smsb-ref-1", 1000, metadata)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true, type: "sms_bundle" })
    expect(h.creditUnitsForPaystack).toHaveBeenCalledWith("acc1", 250, "smsb-ref-1", 10)
  })

  it("a USSD order found by reference is processed without a wallet_payments row", async () => {
    h.tables.ussd_orders = [{
      id: USSD_ID, payment_status: "pending", amount: 10, network: "MTN", recipient_phone: "0241234567",
      dialing_phone: "0241234567", package_size: "1GB", parent_shop_id: null,
    }]
    // No wallet_payments table at all: if the route fell through, it would answer 404.

    const res = await chargeSuccess(USSD_ID, 1000)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true })
    expect(h.tables.ussd_orders[0].payment_status).toBe("completed")
    expect(h.fulfillUssdOrder).toHaveBeenCalledWith(USSD_ID, "MTN", "0241234567", "1GB")
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it("an unknown reference", async () => {
    const res = await chargeSuccess("nobody-knows-this", 1000)

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Payment record not found" })
    expect(h.inserts).toHaveLength(0)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it("a repeated success event credits once", async () => {
    h.tables.wallet_payments = [payment()]
    h.tables.users = [{ id: "u1", phone_number: "0241234567", first_name: "Ama" }]
    // Stateful fake of credit_wallet_safely: a reference already credited is reported as already_processed.
    let balance = 0
    const credited = new Set<string>()
    h.rpc.mockImplementation(async (_name: string, args: any) => {
      if (credited.has(args.p_reference_id)) return { data: [{ new_balance: balance, already_processed: true }], error: null }
      credited.add(args.p_reference_id)
      balance += args.p_amount
      return { data: [{ new_balance: balance, already_processed: false }], error: null }
    })

    const first = await chargeSuccess(REF, 10300)
    const second = await chargeSuccess(REF, 10300)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledTimes(2) // both deliveries ask; the database is what dedups
    expect(balance).toBe(100)
    // The "topped up" SMS goes out for the first delivery only.
    expect(h.sendSMS).toHaveBeenCalledTimes(1)
  })
})

describe("Paystack charge.failed", () => {
  it("charge.failed marks a pending USSD order failed", async () => {
    h.tables.ussd_orders = [{ id: USSD_ID, payment_status: "pending", order_status: "pending" }]
    h.tables.payment_attempts = [{ id: "pa1", reference: USSD_ID, payment_type: "ussd", status: "pending" }]

    const res = await send("charge.failed", { reference: USSD_ID, gateway_response: "Declined" })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true })
    expect(h.tables.ussd_orders[0]).toMatchObject({ payment_status: "failed", order_status: "failed" })
    expect(h.tables.payment_attempts[0]).toMatchObject({ status: "failed", gateway_response: "Declined" })
  })

  it("never flips a completed wallet payment back to failed", async () => {
    h.tables.wallet_payments = [payment({ status: "completed" })]
    await send("charge.failed", { reference: REF, gateway_response: "Declined" })
    expect(h.tables.wallet_payments[0].status).toBe("completed")
  })

  it("marks a pending wallet payment failed", async () => {
    h.tables.wallet_payments = [payment()]
    await send("charge.failed", { reference: REF, gateway_response: "Declined" })
    expect(h.tables.wallet_payments[0].status).toBe("failed")
  })
})

describe("Paystack webhook envelope", () => {
  it("a throwing database call", async () => {
    h.state.throwOn = "ussd_shop_token_purchases" // the first table charge.success reads for an ordinary reference

    const res = await chargeSuccess(REF, 10300)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Internal Server Error" })
  })

  it("a bad signature", async () => {
    const body = JSON.stringify({ event: "charge.success", data: { reference: REF, amount: 10300 } })

    const res = await POST(signed(body, "some-other-secret"))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "Invalid signature" })
    expect(h.state.fromCalls).toBe(0)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it("a missing signature", async () => {
    const body = JSON.stringify({ event: "charge.success", data: { reference: REF, amount: 10300 } })

    const res = await POST(new NextRequest("http://x/api/webhooks/paystack", { method: "POST", body }))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "Invalid request: missing signature" })
    expect(h.state.fromCalls).toBe(0)
  })
})
