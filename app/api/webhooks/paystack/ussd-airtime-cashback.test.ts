// Paystack webhook, USSD airtime branch (reference = airtime_orders id), for an Uzo cashback row.
// Proves, with no webhook change: the paid-amount check accepts total_paid (= quote.payAmount, below
// the airtime face), underpayment is still refused, and the shop credit is exactly merchant_commission
// (= the quote's shop share), once.
import { beforeEach, describe, expect, it, vi } from "vitest"
import crypto from "crypto"

const h = vi.hoisted(() => {
  process.env.PAYSTACK_SECRET_KEY = "test-paystack-secret"
  const state = {
    order: null as any,
    profitInserts: [] as any[],
    flips: 0,
  }
  const fake = {
    from(table: string) {
      let op: "select" | "update" = "select"
      let patch: any = null
      const resolveData = () => (table === "airtime_orders" && state.order ? { ...state.order } : null)
      const q: any = {
        select: () => q, eq: () => q, neq: () => q, in: () => q, gte: () => q, lte: () => q,
        order: () => q, limit: () => q, is: () => q, or: () => q,
        update: (p: any) => { op = "update"; patch = p; return q },
        insert: (rows: any) => {
          const row = Array.isArray(rows) ? rows[0] : rows
          if (table === "shop_profits") state.profitInserts.push(row)
          return q
        },
        maybeSingle: async () => ({ data: resolveData(), error: null }),
        single: async () => ({ data: resolveData(), error: null }),
        then: (ok: any, ko: any) => {
          let res: any = { data: null, error: null }
          if (table === "airtime_orders" && op === "update" && state.order) {
            if (state.order.payment_status !== "completed") {
              Object.assign(state.order, patch)
              state.flips++
              res = { data: [{ id: state.order.id }], error: null }
            } else {
              res = { data: [], error: null }
            }
          }
          return Promise.resolve(res).then(ok, ko)
        },
      }
      return q
    },
    rpc: async () => ({ data: null, error: null }),
  }
  return { state, fake }
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
vi.mock("@/lib/airtime-provider", async (orig) => ({
  ...(await orig<typeof import("@/lib/airtime-provider")>()),
  getAirtimeProvider: vi.fn(async () => "manual"),
}))

import { NextRequest } from "next/server"
import { POST } from "./route"
import { uzoCashbackAirtimeColumns } from "@/lib/ussd/bots/airtime"
import type { StorefrontQuote } from "@/lib/cashback/quote"

const ORDER_ID = "7d1f6c2a-3b4e-4f5a-8b9c-0d1e2f3a4b5c"
const SHOP_ID = "0b6f3c1e-1d2a-4c3b-9e8f-123456789abc"
const QUOTE: StorefrontQuote = {
  applied: true, faceAmount: 10, rate: 10, share: 50, commission: 1, customerCashback: 0.4, shopShare: 0.25,
  payAmount: 9.79, datagodKeeps: 0.35, provider: "hubtel", base: 9.6, paymentFee: 0.19, feeRate: 1.95,
}

/** The row lib/ussd-shop/handlers/airtime.ts inserts for an applied quote (same glue). */
const cashbackShopRow = () => ({
  id: ORDER_ID,
  reference_code: "AT-REF-001",
  network: "MTN",
  beneficiary_phone: "0241234567",
  pay_separately: false,
  status: "pending_payment",
  payment_status: "pending_payment",
  user_id: null,
  shop_id: SHOP_ID,
  customer_name: "USSD Customer",
  customer_email: null,
  dialing_phone: "0201112222",
  channel: "ussd_shop",
  ...uzoCashbackAirtimeColumns(QUOTE, true),
})

function chargeSuccess(pesewas: number) {
  const body = JSON.stringify({
    event: "charge.success",
    data: { id: 555, reference: ORDER_ID, amount: pesewas, status: "success", metadata: { source: "ussd_shop_airtime" } },
  })
  const sig = crypto.createHmac("sha512", "test-paystack-secret").update(body).digest("hex")
  return POST(new NextRequest("http://x/api/webhooks/paystack", { method: "POST", body, headers: { "x-paystack-signature": sig } }))
}

beforeEach(() => {
  h.state.order = cashbackShopRow()
  h.state.profitInserts = []
  h.state.flips = 0
})

describe("Paystack webhook: Uzo cashback airtime row", () => {
  it("the row carries total_paid = payAmount (below face) and merchant_commission = shop share", () => {
    expect(h.state.order).toMatchObject({ airtime_amount: 10, total_paid: 9.79, merchant_commission: 0.25 })
  })

  it("accepts a payment of exactly total_paid and credits exactly the shop share, once", async () => {
    const res = await chargeSuccess(979)
    expect(res.status).toBe(200)
    expect(h.state.order.payment_status).toBe("completed")
    expect(h.state.profitInserts).toEqual([
      expect.objectContaining({ shop_id: SHOP_ID, airtime_order_id: ORDER_ID, profit_amount: 0.25, status: "credited" }),
    ])
    // Duplicate webhook: no second credit.
    expect((await chargeSuccess(979)).status).toBe(200)
    expect(h.state.profitInserts).toHaveLength(1)
    expect(h.state.flips).toBe(1)
  })

  it("still refuses an underpayment below total_paid", async () => {
    const res = await chargeSuccess(970)
    expect(res.status).toBe(400)
    expect(h.state.order.payment_status).toBe("pending_payment")
    expect(h.state.profitInserts).toEqual([])
  })

  it("WhatsApp shop bot cashback row (whatsapp_shop): accepts total_paid, credits the shop share once", async () => {
    // The row createShopAirtimeOrder inserts for the shop bot's applied quote (lib/whatsapp-bot/shop-router.ts):
    // merchant_commission = shopShare, then the cashback columns spread on top.
    h.state.order = {
      ...cashbackShopRow(),
      customer_name: "WhatsApp Customer",
      dialing_phone: "233244123456",
      channel: "whatsapp_shop",
      airtime_amount: 10, fee_amount: 0, total_paid: 9.79, merchant_commission: 0.25,
      ...uzoCashbackAirtimeColumns(QUOTE, true),
    }
    expect(h.state.order).toMatchObject({ total_paid: 9.79, fee_amount: 0, payment_fee_amount: 0.19, merchant_commission: 0.25 })
    expect((await chargeSuccess(979)).status).toBe(200)
    expect(h.state.order.payment_status).toBe("completed")
    expect(h.state.profitInserts).toEqual([
      expect.objectContaining({ shop_id: SHOP_ID, airtime_order_id: ORDER_ID, profit_amount: 0.25, status: "credited" }),
    ])
    expect((await chargeSuccess(979)).status).toBe(200)
    expect(h.state.profitInserts).toHaveLength(1)
    expect(h.state.flips).toBe(1)
    // Underpayment below total_paid is still refused (fresh row).
    h.state.order = { ...cashbackShopRow(), channel: "whatsapp_shop" }
    h.state.profitInserts = []
    expect((await chargeSuccess(970)).status).toBe(400)
    expect(h.state.profitInserts).toEqual([])
  })

  it("main WhatsApp bot cashback row (no shop) accepts total_paid and credits nothing", async () => {
    h.state.order = { ...cashbackShopRow(), shop_id: null, channel: "whatsapp", ...uzoCashbackAirtimeColumns({ ...QUOTE, shopShare: 0.25 }, false) }
    expect(h.state.order.merchant_commission).toBe(0)
    expect((await chargeSuccess(979)).status).toBe(200)
    expect(h.state.order.payment_status).toBe("completed")
    expect(h.state.profitInserts).toEqual([])
  })

  it("main-menu cashback row (no shop) credits nothing", async () => {
    h.state.order = { ...cashbackShopRow(), shop_id: null, channel: "ussd", ...uzoCashbackAirtimeColumns({ ...QUOTE, shopShare: 0.25 }, false) }
    expect(h.state.order.merchant_commission).toBe(0)
    expect((await chargeSuccess(979)).status).toBe(200)
    expect(h.state.order.payment_status).toBe("completed")
    expect(h.state.profitInserts).toEqual([])
  })
})
