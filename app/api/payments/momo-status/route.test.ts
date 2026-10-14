import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// Direct-charge polling + the OTP rejection path for storefront bill / bundle orders (cs_bill / cs_bundle).

const h = vi.hoisted(() => {
  const state = {
    rows: {} as Record<string, any>,
    ops: [] as { table: string; op: string; args: unknown[] }[],
  }
  const chain = (table: string) => {
    const rec = (op: string) => (...args: unknown[]) => (state.ops.push({ table, op, args }), c)
    const c: any = { select: rec("select"), eq: rec("eq"), update: rec("update"), in: rec("in") }
    c.maybeSingle = async () => ({ data: state.rows[table] ?? null, error: null })
    c.then = (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej)
    return c
  }
  return { state, fake: { from: chain } }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() })) }))
const submitOtp = vi.fn(async (..._a: any[]) => ({ status: "failed" }))
vi.mock("@/lib/paystack", () => ({ submitOtp: (...a: any[]) => submitOtp(...a) }))

import { GET } from "./route"
import { POST as submit } from "../submit-otp/route"

const get = (qs: string) => GET(new NextRequest(`http://x/api/payments/momo-status?${qs}`))
const REF = "a".repeat(32)

beforeEach(() => { h.state.rows = {}; h.state.ops = [] })

describe("momo-status for storefront bill / bundle orders", () => {
  it("reads the commission table; paid => completed", async () => {
    h.state.rows.hubtel_bill_orders = { payment_status: "paid" }
    expect(await (await get(`orderId=o1&orderType=cs_bill&reference=${REF}`)).json()).toEqual({ status: "completed" })
    expect(h.state.ops).toContainEqual({ table: "hubtel_bill_orders", op: "eq", args: ["id", "o1"] })
    h.state.rows.hubtel_data_orders = { payment_status: "paid" }
    expect(await (await get(`orderId=o1&orderType=cs_bundle&reference=${REF}`)).json()).toEqual({ status: "completed" })
  })

  it("unpaid + this order's attempt failed => failed (looked up by reference AND order id)", async () => {
    h.state.rows.hubtel_data_orders = { payment_status: "unpaid" }
    h.state.rows.wallet_payments = { status: "failed" }
    expect(await (await get(`orderId=o1&orderType=cs_bundle&reference=${REF}`)).json()).toEqual({ status: "failed" })
    expect(h.state.ops).toContainEqual({ table: "wallet_payments", op: "eq", args: ["reference", REF] })
    expect(h.state.ops).toContainEqual({ table: "wallet_payments", op: "eq", args: ["order_id", "o1"] })
  })

  it("unpaid and still pending (or no reference) => pending; never reads shop_orders", async () => {
    h.state.rows.hubtel_bill_orders = { payment_status: "unpaid" }
    h.state.rows.wallet_payments = { status: "pending" }
    expect(await (await get(`orderId=o1&orderType=cs_bill&reference=${REF}`)).json()).toEqual({ status: "pending" })
    h.state.rows.wallet_payments = { status: "failed" }
    expect(await (await get("orderId=o1&orderType=cs_bill")).json()).toEqual({ status: "pending" })
    expect(h.state.ops.some((o) => o.table === "shop_orders")).toBe(false)
  })
})

describe("submit-otp rejection for storefront bill / bundle orders", () => {
  const post = (body: unknown) => submit(new NextRequest("http://x/api/payments/submit-otp", { method: "POST", body: JSON.stringify(body) }))

  it("marks only this order's pending payment attempt failed; the order stays payable", async () => {
    const res = await post({ reference: REF, otp: "123456", orderId: "o1", orderType: "cs_bill" })
    expect((await res.json()).success).toBe(false)
    expect(h.state.ops.some((o) => o.op === "update" && o.table !== "wallet_payments")).toBe(false)
    expect(h.state.ops).toContainEqual({ table: "wallet_payments", op: "update", args: [{ status: "failed" }] })
    expect(h.state.ops).toContainEqual({ table: "wallet_payments", op: "eq", args: ["reference", REF] })
    expect(h.state.ops).toContainEqual({ table: "wallet_payments", op: "eq", args: ["order_id", "o1"] })
  })

  it("other order types keep failing the order as before", async () => {
    await post({ reference: REF, otp: "1", orderId: "o1", orderType: "airtime" })
    expect(h.state.ops).toContainEqual({ table: "airtime_orders", op: "update", args: [expect.objectContaining({ status: "failed", payment_status: "failed" })] })
  })
})
