import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    order: null as any,
    updateError: null as any,
    updates: [] as any[],
    profitInserts: [] as any[],
  }

  const fake = {
    from: (table: string) => {
      if (table === "airtime_orders") {
        return {
          select: () => ({
            eq: () => ({ single: () => Promise.resolve({ data: state.order ? { ...state.order } : null, error: null }) }),
          }),
          update: (patch: any) => ({
            eq: () => ({
              neq: (_col: string, val: string) => ({
                // Atomic compare-and-set: only the first caller sees a changed row.
                select: () => {
                  state.updates.push(patch)
                  if (state.updateError) return Promise.resolve({ data: null, error: state.updateError })
                  if (state.order.payment_status !== val) {
                    state.order.payment_status = patch.payment_status
                    return Promise.resolve({ data: [{ id: state.order.id }], error: null })
                  }
                  return Promise.resolve({ data: [], error: null })
                },
              }),
            }),
          }),
        }
      }
      if (table === "shop_profits") {
        return {
          insert: (rows: any[]) => {
            state.profitInserts.push(rows[0])
            return Promise.resolve({ data: null, error: null })
          },
        }
      }
      if (table === "admin_settings") {
        return {
          select: () => ({
            eq: () => ({ single: () => Promise.resolve({ data: { value: null }, error: null }) }),
          }),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/digiwapy-provider", () => ({
  isDigiWapyConfigured: vi.fn(() => true),
  isDigiWapyEnabledForNetwork: vi.fn(async () => true),
  sendAirtimeViaDigiwapy: vi.fn(async () => ({ success: true, digiwapyRef: "dgw-1" })),
}))
vi.mock("@/lib/sms-service", () => ({
  notifyAdmins: vi.fn(async () => {}),
  SMSTemplates: { adminAirtimeManualRequired: () => "m", adminAirtimeDigiwapyFailed: () => "m" },
}))
vi.mock("@/lib/email-service", () => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  EmailTemplates: { airtimeAdminAlert: () => ({ subject: "s", html: "h" }) },
}))
vi.mock("@/lib/airtime-hubtel", () => ({ fulfillAirtimeViaHubtel: vi.fn(async () => true) }))
vi.mock("@/lib/hubtel-cs/runtime", () => ({
  getHubtelCsRuntime: () => ({ client: { purchase: vi.fn() }, store: { getByRef: vi.fn() }, onTransition: vi.fn() }),
}))
vi.mock("@/lib/airtime-provider", async (orig) => ({
  ...(await orig<typeof import("@/lib/airtime-provider")>()),
  getAirtimeProvider: vi.fn(async () => "digiwapy"),
}))
vi.mock("./customer-tracking-service", () => ({
  customerTrackingService: { trackCustomer: vi.fn(async () => {}) },
}))

import { markAirtimeOrderPaid } from "./airtime-service"
import { sendAirtimeViaDigiwapy } from "@/lib/digiwapy-provider"

const baseOrder = () => ({
  id: "o1",
  reference_code: "AT-1",
  network: "MTN",
  beneficiary_phone: "0541234567",
  airtime_amount: 10,
  total_paid: 10,
  payment_status: "pending",
  shop_id: "shop-1",
  merchant_commission: 0.5,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.state.order = baseOrder()
  h.state.updateError = null
  h.state.updates = []
  h.state.profitInserts = []
})

describe("markAirtimeOrderPaid — guarded paid flip", () => {
  it("two concurrent calls ⇒ one fulfilment, one profit insert, one reports alreadyProcessed", async () => {
    const [a, b] = await Promise.all([markAirtimeOrderPaid("o1", "tx-1"), markAirtimeOrderPaid("o1", "tx-2")])

    expect(sendAirtimeViaDigiwapy).toHaveBeenCalledTimes(1)
    expect(h.state.profitInserts).toHaveLength(1)
    expect(h.state.profitInserts[0]).toMatchObject({ shop_id: "shop-1", airtime_order_id: "o1", profit_amount: 0.5 })
    expect([a, b]).toContainEqual({ success: true })
    expect([a, b]).toContainEqual({ success: true, alreadyProcessed: true })
  })

  it("writes the same fields as before on the winning call", async () => {
    await markAirtimeOrderPaid("o1", 99)
    expect(h.state.updates[0]).toMatchObject({ payment_status: "completed", status: "pending", transaction_id: 99 })
  })

  it("already completed ⇒ no update, no dispatch", async () => {
    h.state.order.payment_status = "completed"
    const res = await markAirtimeOrderPaid("o1", "tx")
    expect(res).toEqual({ success: true, alreadyProcessed: true })
    expect(h.state.updates).toHaveLength(0)
    expect(sendAirtimeViaDigiwapy).not.toHaveBeenCalled()
    expect(h.state.profitInserts).toHaveLength(0)
  })

  it("update error ⇒ success false, no dispatch, no profit", async () => {
    h.state.updateError = { message: "db down" }
    const res = await markAirtimeOrderPaid("o1", "tx")
    expect(res).toEqual({ success: false })
    expect(sendAirtimeViaDigiwapy).not.toHaveBeenCalled()
    expect(h.state.profitInserts).toHaveLength(0)
  })

  it("missing order ⇒ success false", async () => {
    h.state.order = null
    expect(await markAirtimeOrderPaid("nope")).toEqual({ success: false })
  })
})
