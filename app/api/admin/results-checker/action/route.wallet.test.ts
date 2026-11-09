// The results-checker Refund / Failed action must not mark a Hubtel main-code wallet-paid order "failed and refunded"
// when its handler never marked it paid: that branch credits nothing. Every other case runs as before.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

type Row = Record<string, any>
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  errors: {} as Record<string, { message: string; code?: string }>,
  writes: [] as { table: string; op: string; value: unknown }[],
  refund: vi.fn(async (..._a: unknown[]) => {}),
}))

function from(table: string) {
  const filters: ((r: Row) => boolean)[] = []
  let op: { kind: "update" | "insert"; value: unknown } | null = null
  const q: any = {
    select: () => q,
    update: (v: unknown) => { op = { kind: "update", value: v }; return q },
    insert: (v: unknown) => { op = { kind: "insert", value: v }; return q },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q },
    in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q },
    single: async () => {
      const r = (h.tables[table] ?? []).find((x) => filters.every((f) => f(x)))
      return { data: r ?? null, error: r ? null : { message: "not found" } }
    },
    then: (res: (v: unknown) => unknown) => {
      if (op) {
        h.writes.push({ table, op: op.kind, value: op.value })
        return Promise.resolve({ data: null, error: null }).then(res)
      }
      if (h.errors[table]) return Promise.resolve({ data: null, error: h.errors[table] }).then(res)
      return Promise.resolve({ data: (h.tables[table] ?? []).filter((x) => filters.every((f) => f(x))), error: null }).then(res)
    },
  }
  return q
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from }) }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: async () => ({ isAdmin: true }) }))
vi.mock("@/lib/results-checker-service", () => ({ refundRCOrder: h.refund, fulfillPaidResultsCheckerOrder: vi.fn() }))

import { POST } from "./route"

const post = (action: string) => POST(new NextRequest("http://localhost/api/admin/results-checker/action", {
  method: "POST", body: JSON.stringify({ orderId: "r1", action }),
}))
const order = (o: Row = {}): Row => ({
  id: "r1", user_id: "u1", status: "pending_payment", payment_status: "pending_payment", total_paid: 15,
  exam_board: "WAEC", reference_code: "RC1", ...o,
})
const walletPay = (o: Row = {}): Row => ({ id: "p1", order_table: "results_checker_orders", order_id: "r1", user_id: "u1", amount: 15, state: "needs_review", created_at: "", ...o })
const orderWrites = () => h.writes.filter((w) => w.table === "results_checker_orders" || w.table === "notifications")

beforeEach(() => {
  h.tables = {}
  h.errors = {}
  h.writes = []
  h.refund.mockClear()
})

describe.each(["refund", "failed"])("POST /api/admin/results-checker/action (%s)", (action) => {
  it("refuses with 409 and changes nothing for a wallet-paid order never marked paid", async () => {
    h.tables = { results_checker_orders: [order()], hubtel_wallet_payments: [walletPay()] }
    const res = await post(action)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/refund it by hand from the wallet/i)
    expect(orderWrites()).toEqual([])
    expect(h.refund).not.toHaveBeenCalled()
  })

  it("refuses with 409 and changes nothing when the wallet payments cannot be read", async () => {
    h.tables = { results_checker_orders: [order()] }
    h.errors = { hubtel_wallet_payments: { message: "timeout", code: "57014" } }
    const res = await post(action)
    expect(res.status).toBe(409)
    expect(orderWrites()).toEqual([])
  })

  it("a MoMo-paid (marked paid) order is refunded to the wallet exactly as today, with no wallet-payment read", async () => {
    h.tables = { results_checker_orders: [order({ status: "pending", payment_status: "completed" })] }
    h.errors = { hubtel_wallet_payments: { message: "would refuse if read" } }
    const res = await post(action)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, message: "Order marked as failed and refunded" })
    expect(h.refund).toHaveBeenCalledWith("r1", "u1", 15)
  })

  it("a wallet-paid order that WAS marked paid is refunded to the wallet as today", async () => {
    h.tables = { results_checker_orders: [order({ status: "pending", payment_status: "completed" })], hubtel_wallet_payments: [walletPay()] }
    expect((await post(action)).status).toBe(200)
    expect(h.refund).toHaveBeenCalledWith("r1", "u1", 15)
  })

  it("an unpaid order with no wallet payment is marked failed as today (no credit)", async () => {
    h.tables = { results_checker_orders: [order()], hubtel_wallet_payments: [] }
    const res = await post(action)
    expect(res.status).toBe(200)
    expect(h.refund).not.toHaveBeenCalled()
    expect(h.writes.some((w) => w.table === "results_checker_orders" && w.op === "update" && (w.value as Row).status === "failed")).toBe(true)
  })

  it("before 0159 is applied (no table), an unpaid order is marked failed as today", async () => {
    h.tables = { results_checker_orders: [order()] }
    h.errors = { hubtel_wallet_payments: { message: "missing", code: "PGRST205" } }
    expect((await post(action)).status).toBe(200)
  })
})
