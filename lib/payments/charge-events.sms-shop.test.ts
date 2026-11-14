// A paid ussd_shop_orders row written by the text-to-buy shop line (channel "sms_shop") must be settled exactly like
// a "ussd_shop" one: claimed once, shop and parent profit credited, fulfilment started. handleChargeSuccess finds the
// row by id, so the channel is only a label there; this pins that, so a future channel list cannot silently drop it.
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => {
  type Row = Record<string, any>
  const tables: Record<string, Row[]> = {}
  const inserts: { table: string; rows: Row[] }[] = []
  const fake: any = {
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
        maybeSingle: async () => {
          const hit = rows()[0] ?? null
          if (patch && hit) Object.assign(hit, patch)
          return { data: hit, error: null }
        },
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
  const sendSMS = vi.fn(async (..._a: any[]) => {})
  const fulfillUssdOrder = vi.fn(async (..._a: any[]) => ({ success: true, message: "ok" }))
  const trackCustomer = vi.fn(async (..._a: any[]) => ({ customerId: null }))
  return { tables, inserts, fake, sendSMS, fulfillUssdOrder, trackCustomer }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: h.sendSMS,
  notifyAdmins: vi.fn(async () => {}),
  SMSTemplates: new Proxy({}, { get: () => () => "msg" }),
}))
vi.mock("@/lib/app-settings", () => ({ getJoinCommunityLink: vi.fn(async () => null) }))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async () => {}), notifyAdminsPush: vi.fn(async () => {}) }))
vi.mock("@/lib/internal-url", () => ({ getInternalBaseUrl: () => "http://localhost" }))
vi.mock("@/lib/results-checker-service", () => ({ notifyAdminsNewResultsCheckRequest: vi.fn(async () => {}) }))
vi.mock("@/lib/customer-tracking-service", () => ({ customerTrackingService: { trackCustomer: h.trackCustomer } }))
vi.mock("@/lib/security-log", () => ({ logSecurityEvent: vi.fn() }))
vi.mock("@/lib/ussd/fulfill", () => ({ fulfillUssdOrder: h.fulfillUssdOrder }))

import { handleChargeSuccess } from "./charge-events"

const ORDER_ID = "7f6c1f0e-1111-4222-8333-944455556690"

const shopOrder = (channel: string, over: Record<string, any> = {}) => ({
  id: ORDER_ID, channel, payment_status: "pending", order_status: "pending", amount: 10.3,
  shop_id: "shop1", profit_amount: 1.5, parent_shop_id: "parent1", parent_profit_amount: 0.5,
  network: "MTN", recipient_phone: "0200000102", dialing_phone: "0200000101", package_size: "1GB", ...over,
})

async function pay(channel: string) {
  h.tables.ussd_shop_orders = [shopOrder(channel)]
  const res = await handleChargeSuccess({ reference: ORDER_ID, amount: 1030, id: 9, status: "success" })
  return { res, order: h.tables.ussd_shop_orders[0] }
}

const profitRows = () => h.inserts.filter(i => i.table === "shop_profits").flatMap(i => i.rows)

beforeEach(() => {
  for (const k of Object.keys(h.tables)) delete h.tables[k]
  h.inserts.length = 0
  h.sendSMS.mockClear()
  h.fulfillUssdOrder.mockClear()
  h.trackCustomer.mockClear()
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("a paid ussd_shop_orders row is settled the same way whatever its channel", () => {
  for (const channel of ["ussd_shop", "whatsapp_shop", "sms_shop"]) {
    it(`${channel}: claims the row, credits shop and parent profit, starts fulfilment`, async () => {
      const { res, order } = await pay(channel)
      expect(res?.status).toBe(200)
      expect(order.payment_status).toBe("completed")
      expect(profitRows()).toEqual([
        expect.objectContaining({ shop_id: "shop1", ussd_shop_order_id: ORDER_ID, profit_amount: 1.5, status: "credited" }),
        expect.objectContaining({ shop_id: "parent1", ussd_shop_order_id: ORDER_ID, profit_amount: 0.5, status: "credited" }),
      ])
      expect(h.fulfillUssdOrder).toHaveBeenCalledTimes(1)
      expect(h.fulfillUssdOrder).toHaveBeenCalledWith(ORDER_ID, "MTN", "0200000102", "1GB", false, "ussd_shop_orders")
      expect(h.trackCustomer).toHaveBeenCalledTimes(1)
    })
  }

  it("sms_shop is labelled by its channel in customer tracking", async () => {
    await pay("sms_shop")
    expect(h.trackCustomer.mock.calls[0][0]).toMatchObject({ shopId: "shop1", slug: "sms_shop", orderId: ORDER_ID })
  })

  it("sms_shop: a repeated success event credits and fulfils once", async () => {
    await pay("sms_shop")
    const again = await handleChargeSuccess({ reference: ORDER_ID, amount: 1030, id: 9, status: "success" })
    expect(again?.status).toBe(200)
    expect(profitRows()).toHaveLength(2)
    expect(h.fulfillUssdOrder).toHaveBeenCalledTimes(1)
  })

  it("sms_shop: an underpayment is refused and nothing is credited", async () => {
    h.tables.ussd_shop_orders = [shopOrder("sms_shop")]
    const res = await handleChargeSuccess({ reference: ORDER_ID, amount: 500, id: 9, status: "success" })
    expect(res?.status).toBe(400)
    expect(h.tables.ussd_shop_orders[0].payment_status).toBe("pending")
    expect(profitRows()).toHaveLength(0)
    expect(h.fulfillUssdOrder).not.toHaveBeenCalled()
  })
})
