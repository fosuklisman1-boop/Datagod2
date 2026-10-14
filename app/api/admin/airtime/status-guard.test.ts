import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// Admin "Completed" / "Failed" airtime actions (single + bulk) on storefront orders that /admin/refunds already refunded:
// no second clawback (shop_profits -> failed), no commission re-payout, no wallet credit, no SMS.

type Op = { table: string; op: string; args: unknown[] }
const ops: Op[] = []
let orders: Record<string, unknown>[] = []
let updateMatches = 1 // rows the guarded status update reports changed

function builder(table: string) {
  let kind: "select" | "update" | "insert" = "select"
  const rec = (op: string) => (...args: unknown[]) => { ops.push({ table, op, args }); return q }
  const result = () => {
    if (table === "airtime_orders" && kind === "update") return { data: Array.from({ length: updateMatches }, () => ({ id: "x" })), error: null }
    if (table === "airtime_orders") return { data: orders, error: null }
    return { data: [], error: null }
  }
  const q: any = {
    select: rec("select"), eq: rec("eq"), in: rec("in"), neq: rec("neq"),
    update: (...args: unknown[]) => { kind = "update"; ops.push({ table, op: "update", args }); return q },
    insert: (...args: unknown[]) => { kind = "insert"; ops.push({ table, op: "insert", args }); return q },
    single: async () => (table === "airtime_orders" ? { data: orders[0] ?? null, error: null } : { data: null, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej),
  }
  return q
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => builder(t) }) }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: async () => ({ isAdmin: true, userId: "admin1", errorResponse: null }) }))
const sendSMS = vi.fn(async () => ({}))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: (...a: unknown[]) => (sendSMS as any)(...a),
  SMSTemplates: { airtimeOrderFailed: () => "failed", airtimeOrderDelivered: () => "delivered" },
}))
vi.mock("@/lib/email-service", () => ({ sendEmail: vi.fn(async () => ({})), EmailTemplates: { airtimeOrderFailed: () => ({}), airtimePurchaseConfirmed: () => ({}) } }))

import { POST as action } from "./action/route"
import { POST as bulk } from "./bulk-update-status/route"

const storefrontOrder = (o: Record<string, unknown> = {}) => ({
  id: "a1", reference_code: "AIR-1", user_id: null, shop_id: "shopA", merchant_commission: 0.15, is_flagged: true,
  total_paid: 10.13, airtime_amount: 10, network: "MTN", beneficiary_phone: "0241112222", status: "refunded", users: null, ...o,
})
const req = (body: unknown) => new NextRequest("http://x/api", { method: "POST", body: JSON.stringify(body) })
const touched = (table: string, op?: string) => ops.some((o) => o.table === table && (!op || o.op === op))

beforeEach(() => { ops.length = 0; sendSMS.mockClear(); updateMatches = 1 })

describe("POST /api/admin/airtime/action", () => {
  it("refunded storefront order + Failed: 409, no second clawback, no SMS, no status write", async () => {
    orders = [storefrontOrder()]
    const res = await action(req({ orderId: "a1", action: "failed" }))
    expect(res.status).toBe(409)
    expect(touched("shop_profits")).toBe(false)
    expect(touched("airtime_orders", "update")).toBe(false)
    expect(touched("wallets")).toBe(false)
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it("refunded (or refunding) flagged order + Completed: 409, no commission payout", async () => {
    for (const status of ["refunded", "refunding"]) {
      ops.length = 0
      orders = [storefrontOrder({ status })]
      const res = await action(req({ orderId: "a1", action: "completed" }))
      expect(res.status).toBe(409)
      expect(touched("shop_profits", "insert")).toBe(false)
      expect(sendSMS).not.toHaveBeenCalled()
    }
  })

  it("the status write is guarded; 0 rows changed (refunded meanwhile) stops every side effect", async () => {
    orders = [storefrontOrder({ status: "pending" })]
    updateMatches = 0
    const res = await action(req({ orderId: "a1", action: "failed" }))
    expect(res.status).toBe(409)
    const upd = ops.filter((o) => o.table === "airtime_orders")
    expect(upd).toContainEqual({ table: "airtime_orders", op: "in", args: ["status", ["pending", "processing", "flagged"]] })
    expect(touched("shop_profits")).toBe(false)
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it("a live pending STOREFRONT order fails: commission reversed, but no wallet credit, notification or 'refunded' SMS", async () => {
    orders = [storefrontOrder({ status: "pending" })]
    const res = await action(req({ orderId: "a1", action: "failed" }))
    expect(res.status).toBe(200)
    expect(touched("shop_profits", "update")).toBe(true)
    expect(touched("wallets")).toBe(false)
    expect(touched("transactions")).toBe(false)
    expect(touched("notifications")).toBe(false)
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it("a live pending order with a buyer account still gets the wallet refund flow and SMS", async () => {
    orders = [storefrontOrder({ status: "pending", user_id: "u1", shop_id: null })]
    const res = await action(req({ orderId: "a1", action: "failed" }))
    expect(res.status).toBe(200)
    expect(touched("wallets")).toBe(true)
    expect(touched("notifications", "insert")).toBe(true)
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })
})

describe("POST /api/admin/airtime/bulk-update-status", () => {
  it("skips refunded orders: no clawback, no commission, no SMS", async () => {
    orders = [storefrontOrder(), storefrontOrder({ id: "a2", status: "refunding" })]
    for (const status of ["failed", "completed"]) {
      ops.length = 0
      const res = await bulk(req({ orderIds: ["a1", "a2"], status }))
      const json = await res.json()
      expect(json).toMatchObject({ updated: 0, skipped: 2 })
      expect(touched("shop_profits")).toBe(false)
      expect(touched("airtime_orders", "update")).toBe(false)
    }
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it("bulk Failed on a live storefront order: no wallet credit, notification or SMS", async () => {
    orders = [storefrontOrder({ status: "pending" })]
    const json = await (await bulk(req({ orderIds: ["a1"], status: "failed" }))).json()
    expect(json).toMatchObject({ updated: 1 })
    expect(touched("wallets")).toBe(false)
    expect(touched("notifications")).toBe(false)
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it("guarded write: 0 rows changed => skipped with no side effects", async () => {
    orders = [storefrontOrder({ status: "processing" })]
    updateMatches = 0
    const json = await (await bulk(req({ orderIds: ["a1"], status: "completed" }))).json()
    expect(json).toMatchObject({ updated: 0, skipped: 1 })
    expect(touched("shop_profits")).toBe(false)
    expect(sendSMS).not.toHaveBeenCalled()
  })
})
