// lib/ussd-hubtel/order-handlers.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const fulfillUssdOrder = vi.fn()
const sendSMS = vi.fn()
vi.mock("@/lib/ussd/fulfill", () => ({ fulfillUssdOrder: (...a: any[]) => fulfillUssdOrder(...a) }))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: (...a: any[]) => sendSMS(...a),
  SMSTemplates: { ussdOrderConfirmed: () => "confirmed", ussdPaymentConfirmed: () => "paid" },
}))
vi.mock("@/lib/app-settings", () => ({ getJoinCommunityLink: async () => "link" }))

import { createOrderHandlers } from "./order-handlers"

/** Chainable fake: ussd_orders select returns `order`; update chain with .select() honours the payable-state filter. */
function fakeSupabase(order: any) {
  const updates: any[] = []
  const client = {
    from(table: string) {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "ussd_orders" ? order : null, error: null }) }) }),
        update: (patch: any) => {
          const filters: { payable?: string[] } = {}
          const chain: any = {
            eq: () => chain,
            in: (_col: string, vals: string[]) => { filters.payable = vals; return chain },
            select: async () => {
              const ok = !filters.payable || filters.payable.includes(order.payment_status)
              if (ok) updates.push(patch)
              return { data: ok ? [{ id: order.id }] : [], error: null }
            },
            then: (res: any) => res({ error: null }),
          }
          return chain
        },
        insert: async () => ({ error: null }),
      }
    },
  }
  return { client: client as any, updates }
}

const baseOrder = {
  id: "o1", network: "MTN", recipient_phone: "0241234567", dialing_phone: "0241234567",
  package_size: "1", parent_shop_id: null, parent_profit_amount: 0,
}

describe("ussd_orders post-payment handler", () => {
  beforeEach(() => { fulfillUssdOrder.mockReset(); sendSMS.mockReset(); fulfillUssdOrder.mockResolvedValue({ success: true, message: "ok" }) })

  it("failed order → throws, no fulfilment, no SMS", async () => {
    const { client } = fakeSupabase({ ...baseOrder, payment_status: "failed" })
    await expect(createOrderHandlers(client).ussd_orders("o1")).rejects.toThrow(/not in a payable state: failed/)
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it("pending order → marks completed, fulfils once, SMSes recipient", async () => {
    const { client, updates } = fakeSupabase({ ...baseOrder, payment_status: "pending" })
    await createOrderHandlers(client).ussd_orders("o1")
    expect(updates[0]).toMatchObject({ payment_status: "completed" })
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(sendSMS.mock.calls[0][0].phone).toBe("0241234567")
  })

  it("already completed → returns without fulfilling", async () => {
    const { client } = fakeSupabase({ ...baseOrder, payment_status: "completed" })
    await createOrderHandlers(client).ussd_orders("o1")
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })
})
