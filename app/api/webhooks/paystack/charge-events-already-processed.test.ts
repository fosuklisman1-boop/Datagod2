// Pins what the REAL handleChargeSuccess answers for each "already processed" branch, as seen by
// lib/hubtel-pay/confirm.ts. A completed order answers exactly like a real fulfilment. An order closed any other way
// adds order_closed, still 200, so confirm can tell a payment that delivered nothing from one that was fulfilled.
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
        select: () => q, order: () => q, limit: () => q, gte: () => q, lte: () => q, is: () => q, or: () => q, neq: () => q, in: () => q,
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q },
        update: (p: Row) => { patch = p; return q },
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
    rpc: async () => ({ data: null, error: null }),
  }
  return {
    tables, fake,
    fulfillUssdOrder: vi.fn(async (..._a: any[]) => ({ success: true, message: "ok" })),
    markAirtimeOrderPaid: vi.fn(async (..._a: any[]) => {}),
    fulfillPaidResultsCheckerOrder: vi.fn(async (..._a: any[]) => ({ success: true })),
  }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: vi.fn(async () => {}),
  notifyAdmins: vi.fn(async () => {}),
  SMSTemplates: new Proxy({}, { get: () => () => "msg" }),
}))
vi.mock("@/lib/app-settings", () => ({ getJoinCommunityLink: vi.fn(async () => null) }))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async () => {}), notifyAdminsPush: vi.fn(async () => {}) }))
vi.mock("@/lib/internal-url", () => ({ getInternalBaseUrl: () => "http://localhost" }))
vi.mock("@/lib/results-checker-service", () => ({
  notifyAdminsNewResultsCheckRequest: vi.fn(async () => {}),
  fulfillPaidResultsCheckerOrder: h.fulfillPaidResultsCheckerOrder,
}))
vi.mock("@/lib/airtime-service", () => ({ markAirtimeOrderPaid: h.markAirtimeOrderPaid }))
vi.mock("@/lib/admin-actions/withdrawal-hook", () => ({ notifyWithdrawalCompleted: vi.fn(async () => {}) }))
vi.mock("@/lib/customer-tracking-service", () => ({ customerTrackingService: { trackCustomer: vi.fn(async () => ({ customerId: null })) } }))
vi.mock("@/lib/security-log", () => ({ logSecurityEvent: vi.fn() }))
vi.mock("@/lib/sms/bundle-service", () => ({ creditUnitsForPaystack: vi.fn(async () => ({ ok: true })), getPricePerCredit: vi.fn(async () => 1) }))
vi.mock("@/lib/ussd/fulfill", () => ({ fulfillUssdOrder: h.fulfillUssdOrder }))

import { handleChargeFailed, handleChargeSuccess } from "@/lib/payments/charge-events"
import { confirmHubtelPayment, type HubtelPaymentRow, type HubtelPaymentStore } from "@/lib/hubtel-pay/confirm"

const ID = "7f6c1f0e-1111-4222-8333-944455556666"
const REF = "0123456789abcdef0123456789abcdef"
const charge = (reference = ID) => ({ reference, amount: 1000, id: "tx-1", gateway_response: "Hubtel: Paid" })
const bodyOf = async (reference = ID) => {
  const res = await handleChargeSuccess(charge(reference))
  return { status: res!.status, body: await res!.json() }
}
const ANSWER = { status: 200, body: { received: true } }
const CLOSED = { status: 200, body: { received: true, order_closed: true } }

beforeEach(() => {
  for (const k of Object.keys(h.tables)) delete h.tables[k]
  h.fulfillUssdOrder.mockClear()
  h.markAirtimeOrderPaid.mockClear()
  h.fulfillPaidResultsCheckerOrder.mockClear()
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("handleChargeSuccess — the answer confirm.ts sees", () => {
  it("a real USSD fulfilment answers {received:true}: the baseline the branches below are identical to", async () => {
    h.tables.ussd_orders = [{ id: ID, payment_status: "pending", amount: 10, network: "MTN", recipient_phone: "0241234567", package_size: "1GB", parent_shop_id: null }]
    expect(await bodyOf()).toEqual(ANSWER)
    expect(h.fulfillUssdOrder).toHaveBeenCalledTimes(1)
  })

  const orderTables: [string, string][] = [["USSD", "ussd_orders"], ["USSD AFA", "ussd_afa_orders"], ["USSD shop", "ussd_shop_orders"]]
  const closedStatuses = ["failed", "abandoned", "expired"]

  it.each(orderTables)("%s order (%s) already completed → exactly {received:true}, nothing re-delivered", async (_n, table) => {
    h.tables[table] = [{ id: ID, payment_status: "completed", amount: 10, network: "MTN", recipient_phone: "0241234567" }]
    expect(await bodyOf()).toEqual(ANSWER)
    expect(h.fulfillUssdOrder).not.toHaveBeenCalled()
  })

  it.each(orderTables.flatMap(([n, t]) => closedStatuses.map((s) => [n, t, s])))("%s order (%s) closed as %s → 200 with order_closed, nothing delivered, row untouched", async (_n, table, payment_status) => {
    h.tables[table] = [{ id: ID, payment_status, amount: 10, network: "MTN", recipient_phone: "0241234567" }]
    expect(await bodyOf()).toEqual(CLOSED)
    expect(h.fulfillUssdOrder).not.toHaveBeenCalled()
    expect(h.tables[table][0].payment_status).toBe(payment_status)
  })

  /** The two ways a token purchase is reached: its own paystack_reference, or a wallet_payments row pointing at it. */
  const tokenPurchase: Record<string, (payment_status: string) => void> = {
    "by paystack_reference": (payment_status) => {
      h.tables.ussd_shop_token_purchases = [{ id: "p1", paystack_reference: ID, payment_status }]
    },
    "via wallet_payments": (payment_status) => {
      h.tables.wallet_payments = [{ id: "wp1", reference: ID, user_id: "u1", order_id: "p2", order_type: "ussd_shop_token", amount: 10, fee: 0, status: "pending" }]
      h.tables.ussd_shop_token_purchases = [{ id: "p2", paystack_reference: null, payment_status }]
    },
  }

  it.each(Object.keys(tokenPurchase))("shop token purchase %s, already completed → exactly {received:true}", async (route) => {
    tokenPurchase[route]("completed")
    expect(await bodyOf()).toEqual(ANSWER)
  })

  it.each(Object.keys(tokenPurchase))("shop token purchase %s, closed as failed → 200 with order_closed", async (route) => {
    tokenPurchase[route]("failed")
    expect(await bodyOf()).toEqual(CLOSED)
  })

  it("airtime already completed → {received:true}, not re-marked", async () => {
    h.tables.airtime_orders = [{ id: ID, payment_status: "completed", total_paid: 10 }]
    expect(await bodyOf()).toEqual(ANSWER)
    expect(h.markAirtimeOrderPaid).not.toHaveBeenCalled()
  })

  it("results-checker order already completed → {received:true}, not re-fulfilled", async () => {
    h.tables.results_checker_orders = [{ id: ID, status: "completed", total_paid: 10 }]
    expect(await bodyOf()).toEqual(ANSWER)
    expect(h.fulfillPaidResultsCheckerOrder).not.toHaveBeenCalled()
  })

  it("results check request already paid → {received:true}", async () => {
    h.tables.results_check_requests = [{ id: ID, payment_status: "paid", fee: 10 }]
    expect(await bodyOf()).toEqual(ANSWER)
  })

  // These two tables only stop on `completed`: a payment on a FAILED order is processed, so the gap does not apply.
  it("airtime that had FAILED is still processed", async () => {
    h.tables.airtime_orders = [{ id: ID, payment_status: "failed", total_paid: 10, airtime_amount: 10, network: "MTN", beneficiary_phone: "0241234567", dialing_phone: "0241234567" }]
    expect(await bodyOf()).toEqual(ANSWER)
    expect(h.markAirtimeOrderPaid).toHaveBeenCalledTimes(1)
  })

  it("a results-checker order that had FAILED is still processed", async () => {
    h.tables.results_checker_orders = [{ id: ID, status: "failed", payment_status: "failed", total_paid: 10 }]
    expect(await bodyOf()).toEqual(ANSWER)
    expect(h.fulfillPaidResultsCheckerOrder).toHaveBeenCalledTimes(1)
  })
})

describe("confirmHubtelPayment through the real handler", () => {
  function run(row: Partial<HubtelPaymentRow>) {
    const stored: HubtelPaymentRow = {
      reference: REF, internal_reference: ID, amount_pesewas: 1000, status: "pending", claimed_at: null, claim_count: 0,
      created_at: "2026-11-04T09:59:00.000Z", expires_at: "2026-11-04T10:15:00.000Z", ...row,
    }
    const store: HubtelPaymentStore = {
      load: async () => ({ ...stored }),
      claim: async () => { stored.status = "confirming"; stored.claimed_at = "c1"; stored.claim_count = 1; return { ...stored } },
      hasLiveSibling: async () => false,
      hasPaidSibling: async () => false,
      update: async (_r, patch) => { Object.assign(stored, patch); return true },
    }
    const notify = vi.fn(async () => {})
    const outcome = confirmHubtelPayment(REF, {
      store, notify, now: () => new Date("2026-11-04T10:00:00.000Z"),
      checkStatus: async () => ({ kind: "paid", amountPesewas: 1000, paymentMethod: "mobilemoney", transactionId: "tx-1", raw: {} }),
      onChargeSuccess: handleChargeSuccess,
      onChargeFailed: handleChargeFailed,
    })
    return { outcome, stored, notify }
  }

  it("a pending USSD order → fulfilled, paid, delivered", async () => {
    h.tables.ussd_orders = [{ id: ID, payment_status: "pending", amount: 10, network: "MTN", recipient_phone: "0241234567", package_size: "1GB", parent_shop_id: null }]
    const t = run({})
    expect(await t.outcome).toBe("fulfilled")
    expect(t.stored.status).toBe("paid")
    expect(h.fulfillUssdOrder).toHaveBeenCalledTimes(1)
  })

  const seedOrder = (table: string, payment_status: string) => {
    h.tables[table] = table === "ussd_shop_token_purchases"
      ? [{ id: "p1", paystack_reference: ID, payment_status }]
      : [{ id: ID, payment_status, amount: 10, network: "MTN", recipient_phone: "0241234567" }]
  }
  const tables = ["ussd_orders", "ussd_afa_orders", "ussd_shop_orders", "ussd_shop_token_purchases"]

  it.each(tables)("a payment landing on a failed %s row → needs_review with one alert, not paid", async (table) => {
    seedOrder(table, "failed")
    const t = run({})
    expect(await t.outcome).toBe("needs_review")
    expect(t.stored.status).toBe("needs_review")
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(h.fulfillUssdOrder).not.toHaveBeenCalled()
  })

  it.each(tables)("a re-run on a completed %s row (fulfilled, final write lost) → paid, no alert", async (table) => {
    seedOrder(table, "completed")
    const t = run({})
    expect(await t.outcome).toBe("fulfilled")
    expect(t.stored.status).toBe("paid")
    expect(t.notify).not.toHaveBeenCalled()
  })
})
