// Hubtel main-code orders paid from the wallet (hubtel_wallet_payments, migration 0159): refunds go back to that
// wallet only, once; the admin always sees the money; MoMo-paid orders keep today's rails.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ credits: [] as Record<string, unknown>[] }))
// The wallet gateway builds its own service client at import: capture its credit_wallet_safely calls.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "credit_wallet_safely") h.credits.push(args)
      return { data: null, error: null }
    },
  }),
}))

import { loadRefundableOrders } from "./orders"
import { orderEligibility } from "./eligibility"
import { listGateways, supportOf, getGateway } from "./gateways"
import { executeRefund, type RefundDeps } from "./service"
import { HUBTEL_WALLET_REASON, listHubtelWalletAttention } from "./hubtel-wallet"
import type { OrderTable, RefundableOrder } from "./types"

type Rows = Record<string, unknown[]>

/** Chainable fake: every builder is thenable and returns the canned rows for its table (filters are not applied). */
function fakeDb(rows: Rows, errors: Record<string, { message: string; code?: string }> = {}) {
  const make = (table: string) => {
    const self = () => q
    const q: any = {
      select: self, eq: self, in: self, is: self, neq: self, gte: self, lte: self, lt: self,
      order: self, range: self, limit: self, ilike: self, or: self, not: self,
      maybeSingle: async () => ({ data: (rows[table] ?? [])[0] ?? null, error: errors[table] ?? null }),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: errors[table] ? null : rows[table] ?? [], error: errors[table] ?? null }).then(res),
    }
    return q
  }
  return { from: (t: string) => make(t) } as any
}

const NOW = Date.parse("2026-11-08T12:00:00Z")
const OLD = "2026-11-08T11:00:00Z" // an hour ago
const FRESH = "2026-11-08T11:55:00Z" // five minutes ago

const ussdOrder = (o: Record<string, unknown> = {}) => ({
  id: "o1", dialing_phone: "+233241112222", recipient_phone: "+233241112222", network: "MTN", package_size: "2GB",
  amount: 12, order_status: "pending", payment_status: "completed", paystack_reference: null, created_at: OLD, ...o,
})
const walletPayment = (o: Record<string, unknown> = {}) => ({
  id: "pay-1", session_id: "S1", order_table: "ussd_orders", order_id: "o1", user_id: "uWallet", amount: 12,
  state: "fulfilled", review_reason: null, created_at: OLD, updated_at: OLD, ...o,
})

const EVERY_RAIL_ON = { HUBTEL_REFUND_ENABLED: "true", HUBTEL_SEND_REFUNDS_ENABLED: "true" }
let savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  h.credits = []
  savedEnv = Object.fromEntries(Object.keys(EVERY_RAIL_ON).map((k) => [k, process.env[k]]))
  Object.assign(process.env, EVERY_RAIL_ON)
})
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const load = async (table: OrderTable, id: string, rows: Rows) => (await loadRefundableOrders(fakeDb(rows), [{ table, id }]))[0]
const okRails = (o: RefundableOrder) => listGateways().filter((g) => supportOf(g, o).ok).map((g) => g.id)

describe("ussd_orders paid from the wallet on the Hubtel main code", () => {
  for (const state of ["fulfilled", "needs_review"] as const) {
    it(`(${state}) is refundable, to the paying wallet only, for what was debited`, async () => {
      const o = await load("ussd_orders", "o1", { ussd_orders: [ussdOrder()], hubtel_wallet_payments: [walletPayment({ state })] })
      expect(o.payment).toMatchObject({ gateway: "wallet", walletUserId: "uWallet", reference: null })
      expect(o.payment.hubtelWallet).toMatchObject({ paymentId: "pay-1", state, amount: 12 })
      expect(o.paid).toBe(12)
      expect(o.gatewayFee).toBe(0)
      expect(orderEligibility(o, NOW)).toEqual({ eligible: true })
      expect(okRails(o)).toEqual(["wallet"])
    })
  }

  it("refuses Hubtel, Moolre, the MoMo payouts, Paystack and the manual rail, with the wallet reason", async () => {
    const o = await load("ussd_orders", "o1", { ussd_orders: [ussdOrder()], hubtel_wallet_payments: [walletPayment()] })
    for (const id of ["hubtel", "hubtel_send", "moolre", "paystack_payout", "paystack", "manual"]) {
      const s = supportOf(getGateway(id)!, o)
      expect(s.ok, id).toBe(false)
      if (!s.ok) expect(s.reason, id).toBe(HUBTEL_WALLET_REASON)
    }
  })

  it("is not refundable while the payment is still debited: the sweep may still deliver it", async () => {
    const o = await load("ussd_orders", "o1", { ussd_orders: [ussdOrder()], hubtel_wallet_payments: [walletPayment({ state: "debited" })] })
    expect(orderEligibility(o, NOW)).toMatchObject({ eligible: false, code: "WALLET_UNSETTLED" })
  })

  it("takes the wallet owner from the payment row, never from a debit someone else attached to the order", async () => {
    const o = await load("ussd_orders", "o1", {
      ussd_orders: [ussdOrder()],
      hubtel_wallet_payments: [walletPayment()],
      transactions: [{ reference_id: "o1", user_id: "uEvil", type: "debit", amount: 12 }],
    })
    expect(o.payment.walletUserId).toBe("uWallet")
  })

  it("ignores a payment row for another table or order", async () => {
    const o = await load("ussd_orders", "o1", {
      ussd_orders: [ussdOrder()],
      hubtel_wallet_payments: [walletPayment({ order_table: "airtime_orders" }), walletPayment({ id: "pay-2", order_id: "other" })],
    })
    expect(o.payment.hubtelWallet).toBeUndefined()
  })

  it("loads as before when hubtel_wallet_payments does not exist yet (0159 not applied)", async () => {
    const db = fakeDb({ ussd_orders: [ussdOrder()] }, { hubtel_wallet_payments: { message: "relation does not exist", code: "42P01" } })
    const [o] = await loadRefundableOrders(db, [{ table: "ussd_orders", id: "o1" }])
    expect(o.payment.hubtelWallet).toBeUndefined()
  })

  it("throws on any other hubtel_wallet_payments read error: an unread payment is never treated as none", async () => {
    const db = fakeDb({ ussd_orders: [ussdOrder()] }, { hubtel_wallet_payments: { message: "timeout", code: "57014" } })
    await expect(loadRefundableOrders(db, [{ table: "ussd_orders", id: "o1" }])).rejects.toThrow(/hubtel_wallet_payments/)
  })
})

describe("refunding a wallet-paid Hubtel order: once, to the same wallet", () => {
  function deps(rows: Rows) {
    const refunds: { status: string }[] = []
    let n = 0
    const d: RefundDeps = {
      async rpc(name) {
        if (name === "reserve_order_refund") {
          // reserve_order_refund's own guard (0154): one non-failed refund per order.
          if (refunds.some((r) => r.status !== "failed")) return { data: null, error: { message: "ALREADY_REFUNDED" } }
          refunds.push({ status: "reserved" })
          return { data: { refund_id: `rf-${++n}`, clawbacks: [] }, error: null }
        }
        if (name === "complete_order_refund") {
          refunds[refunds.length - 1].status = "completed"
          return { data: "completed", error: null }
        }
        return { data: null, error: null }
      },
      loadOrder: async (table, id) => (await loadRefundableOrders(fakeDb(rows), [{ table, id }]))[0] ?? null,
      getGateway,
      notify: async () => {},
      now: () => NOW,
    }
    return d
  }
  const rows = (): Rows => ({ ussd_orders: [ussdOrder()], hubtel_wallet_payments: [walletPayment({ state: "needs_review" })] })
  const input = { table: "ussd_orders" as const, orderId: "o1", gateway: "wallet", amount: 12, adminId: "admin-1" }

  it("credits the paying user's wallet, and the reserve guard refuses a second refund", async () => {
    const d = deps(rows())
    await expect(executeRefund(d, input)).resolves.toMatchObject({ status: "completed" })
    expect(h.credits).toEqual([expect.objectContaining({ p_user_id: "uWallet", p_amount: 12, p_reference_id: "REFUND_rf-1" })])
    await expect(executeRefund(d, input)).rejects.toMatchObject({ code: "ALREADY_REFUNDED" })
    expect(h.credits).toHaveLength(1)
  })

  it("refuses before the reserve once a refund is on record", async () => {
    const d = deps({ ...rows(), order_refunds: [{ order_id: "o1", status: "completed" }] })
    await expect(executeRefund(d, input)).rejects.toMatchObject({ code: "NOT_ELIGIBLE", detail: { code: "ALREADY_REFUNDED" } })
    expect(h.credits).toHaveLength(0)
  })

  it("refuses the manual and Moolre rails at execute too", async () => {
    for (const gateway of ["manual", "moolre", "hubtel", "hubtel_send"]) {
      await expect(executeRefund(deps(rows()), { ...input, gateway })).rejects.toMatchObject({ code: "GATEWAY_UNSUPPORTED" })
    }
    expect(h.credits).toHaveLength(0)
  })

  it("never refunds more than was debited", async () => {
    await expect(executeRefund(deps(rows()), { ...input, amount: 12.01 })).rejects.toMatchObject({ code: "BAD_AMOUNT" })
  })
})

describe("MoMo-paid orders on the same tables keep today's rails", () => {
  it("a Hubtel checkout-paid ussd_orders row: Hubtel, Hubtel Send Money, both payouts and manual", async () => {
    const o = await load("ussd_orders", "o1", {
      ussd_orders: [ussdOrder()],
      hubtel_transactions: [{ order_id: "o1", hubtel_order_id: "H1", amount_paid: 12.24, amount_after_charges: 12, paid_at: new Date().toISOString(), mobile: "233241112222" }],
    })
    expect(o.payment.gateway).toBe("hubtel")
    expect(o.payment.hubtelWallet).toBeUndefined()
    expect(okRails(o)).toEqual(["hubtel_send", "paystack_payout", "moolre", "hubtel", "manual"])
  })

  it("an Uzo wallet-paid ussd_orders row (debit only, no Hubtel payment row) keeps the wallet and manual rails", async () => {
    const o = await load("ussd_orders", "o1", { ussd_orders: [ussdOrder()], transactions: [{ reference_id: "o1", user_id: "uW", type: "debit", amount: 12 }] })
    expect(okRails(o)).toEqual(["wallet", "manual"])
  })

  it("airtime_orders main-code rows stay off this page's rails (refunded on /admin/airtime), wallet-paid or not", async () => {
    const airtime = { id: "a1", shop_id: null, user_id: "uWallet", channel: "ussd", dialing_phone: "+233241112222", network: "MTN",
      beneficiary_phone: "0241112222", airtime_amount: 5, total_paid: 5, status: "pending", payment_status: "completed", notes: null,
      created_at: OLD, updated_at: OLD }
    for (const hw of [[], [walletPayment({ order_table: "airtime_orders", order_id: "a1", amount: 5 })]]) {
      const o = await load("airtime_orders", "a1", { airtime_orders: [airtime], hubtel_wallet_payments: hw })
      expect(orderEligibility(o, NOW)).toMatchObject({ eligible: false, code: "NOT_STOREFRONT" })
      expect(okRails(o)).not.toContain("wallet")
    }
  })
})

/** In-memory store that applies eq / in / lt / gte, order, range and limit, so paging and filters are really exercised. */
function storeDb(rows: Rows, errors: Record<string, { message: string; code?: string }> = {}) {
  const make = (table: string) => {
    const filters: ((r: any) => boolean)[] = []
    const orders: [string, boolean][] = []
    let lo = 0
    let hi = Infinity
    const q: any = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q },
      lt: (c: string, v: string) => { filters.push((r) => String(r[c]) < v); return q },
      gte: (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return q },
      order: (c: string, o?: { ascending?: boolean }) => { orders.push([c, o?.ascending !== false]); return q },
      range: (a: number, b: number) => { lo = a; hi = b; return q },
      limit: (n: number) => { lo = 0; hi = n - 1; return q },
      then: (res: (v: unknown) => unknown) => {
        if (errors[table]) return Promise.resolve({ data: null, error: errors[table] }).then(res)
        const out = ((rows[table] ?? []) as any[]).filter((r) => filters.every((f) => f(r))).sort((a, b) => {
          for (const [c, asc] of orders) {
            const x = String(a[c]), y = String(b[c])
            if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1)
          }
          return 0
        })
        return Promise.resolve({ data: out.slice(lo, hi + 1), error: null }).then(res)
      },
    }
    return q
  }
  return { from: (t: string) => make(t) } as any
}

describe("listHubtelWalletAttention: wallet money an admin must see on /admin/refunds", () => {
  const pay = (o: Record<string, unknown>) => walletPayment(o)
  const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

  it("lists needs_review payments and payments still debited 10+ minutes on, each with its reason, on all four tables", async () => {
    const db = storeDb({
      hubtel_wallet_payments: [
        pay({ id: "p1", order_table: "ussd_orders", order_id: "o1", state: "needs_review", review_reason: "post-payment error" }),
        pay({ id: "p2", order_table: "airtime_orders", order_id: "a1", state: "debited", created_at: OLD, amount: 5 }),
        pay({ id: "p3", order_table: "results_checker_orders", order_id: "r1", state: "needs_review", amount: 15 }),
        pay({ id: "p4", order_table: "results_check_requests", order_id: "q1", state: "needs_review", amount: 22 }),
        pay({ id: "p5", order_table: "ussd_orders", order_id: "o5", state: "debited", created_at: FRESH }), // too recent
        pay({ id: "p6", order_table: "ussd_orders", order_id: "o6", state: "fulfilled" }),
      ],
      ussd_orders: [{ id: "o1", order_status: "pending", payment_status: "pending" }, { id: "o6", order_status: "pending", payment_status: "completed", created_at: OLD }],
      airtime_orders: [{ id: "a1", status: "pending_payment", payment_status: "pending_payment" }],
      results_checker_orders: [{ id: "r1", status: "pending", payment_status: "completed" }],
      results_check_requests: [{ id: "q1", status: "pending", payment_status: "pending_payment" }],
    })
    const { rows, truncated } = await listHubtelWalletAttention(db, NOW)
    expect(truncated).toBe(false)
    expect(rows.map((r) => r.paymentId).sort()).toEqual(["p1", "p2", "p3", "p4"])
    const p1 = rows.find((r) => r.paymentId === "p1")!
    expect(p1).toMatchObject({ orderTable: "ussd_orders", orderId: "o1", amount: 12, kind: "needs_review", orderStatus: "pending", reviewReason: "post-payment error" })
    expect(p1.reason).toMatch(/not completed/i)
    expect(rows.find((r) => r.paymentId === "p2")!.reason).toMatch(/sweep/i)
    for (const r of rows) expect(r.refundHint.length).toBeGreaterThan(0)
    expect(rows.find((r) => r.paymentId === "p2")!.refundHint).toMatch(/do not refund/i)
  })

  it("hints a refund tool only when the order was marked paid; otherwise: credit the wallet by hand", async () => {
    const review = (table: string, id: string) => pay({ id: `p-${id}`, order_table: table, order_id: id, state: "needs_review" })
    const db = storeDb({
      hubtel_wallet_payments: [
        review("results_checker_orders", "rPaid"), review("results_checker_orders", "rUnpaid"),
        review("airtime_orders", "aPaid"), review("airtime_orders", "aUnpaid"),
        review("ussd_orders", "uPaid"), review("ussd_orders", "uUnpaid"),
      ],
      results_checker_orders: [{ id: "rPaid", status: "pending", payment_status: "completed" }, { id: "rUnpaid", status: "pending_payment", payment_status: "pending_payment" }],
      airtime_orders: [{ id: "aPaid", status: "pending", payment_status: "completed" }, { id: "aUnpaid", status: "pending_payment", payment_status: "pending_payment" }],
      ussd_orders: [{ id: "uPaid", order_status: "pending", payment_status: "completed" }, { id: "uUnpaid", order_status: "pending", payment_status: "pending" }],
    })
    const hint = async (id: string) => (await listHubtelWalletAttention(db, NOW)).rows.find((r) => r.orderId === id)!.refundHint
    expect(await hint("rPaid")).toMatch(/Refund on \/admin\/results-checker: that credits the buyer's wallet/)
    expect(await hint("rUnpaid")).toMatch(/credit the wallet by hand/i)
    expect(await hint("rUnpaid")).not.toMatch(/that credits the buyer's wallet/)
    expect(await hint("aPaid")).toMatch(/mark it Failed on \/admin\/airtime: that credits the buyer's wallet/)
    expect(await hint("aUnpaid")).toMatch(/credit the wallet by hand/i)
    expect(await hint("aUnpaid")).not.toMatch(/that credits the buyer's wallet/)
    expect(await hint("uPaid")).toMatch(/Pending orders on this page/)
    expect(await hint("uUnpaid")).toMatch(/credit the wallet by hand/i)
  })

  it("lists a fulfilled wallet payment whose ussd_orders row is failed or reversed, with the hand-refund hint", async () => {
    const db = storeDb({
      hubtel_wallet_payments: [
        pay({ id: "pf", order_id: "oFailed", state: "fulfilled", created_at: at(120) }),
        pay({ id: "pr", order_id: "oReversed", state: "fulfilled", created_at: at(100) }),
        pay({ id: "pp", order_id: "oPending", state: "fulfilled", created_at: at(90) }),
        pay({ id: "pu", order_id: "oFailedUnpaid", state: "fulfilled", created_at: at(80) }),
        pay({ id: "pa", order_table: "airtime_orders", order_id: "oFailed", state: "fulfilled", created_at: at(70) }),
      ],
      ussd_orders: [
        { id: "oFailed", order_status: "failed", payment_status: "completed", created_at: at(121) },
        { id: "oReversed", order_status: "reversed", payment_status: "completed", created_at: at(101) },
        { id: "oPending", order_status: "pending", payment_status: "completed", created_at: at(91) },
        { id: "oFailedUnpaid", order_status: "failed", payment_status: "failed", created_at: at(81) },
        { id: "oNoWallet", order_status: "failed", payment_status: "completed", created_at: at(60) },
        { id: "oBeforeWallet", order_status: "failed", payment_status: "completed", created_at: at(60 * 24 * 30) },
      ],
    })
    const { rows } = await listHubtelWalletAttention(db, NOW)
    expect(rows.map((r) => r.paymentId).sort()).toEqual(["pf", "pr"])
    for (const r of rows) {
      expect(r.kind).toBe("failed_order")
      expect(r.refundHint).toBe("Refund by hand from the wallet; check it wasn't resent first.")
    }
    expect(rows.find((r) => r.paymentId === "pr")!.orderStatus).toBe("reversed")
  })

  it("drops a needs_review payment once its order is completed or refunded, but keeps a stale debited one", async () => {
    const db = storeDb({
      hubtel_wallet_payments: [
        pay({ id: "p1", order_id: "o1", state: "needs_review" }),
        pay({ id: "p2", order_id: "o2", state: "needs_review" }),
        pay({ id: "p3", order_id: "o3", state: "debited" }),
        pay({ id: "p4", order_id: "o4", state: "needs_review" }),
      ],
      ussd_orders: [{ id: "o1", order_status: "completed" }, { id: "o2", order_status: "refunded" }, { id: "o3", order_status: "completed" }, { id: "o4", order_status: "failed" }],
    })
    expect((await listHubtelWalletAttention(db, NOW)).rows.map((r) => r.paymentId).sort()).toEqual(["p3", "p4"])
  })

  it("pages past resolved needs_review rows, so older unresolved ones never fall off", async () => {
    const resolved = Array.from({ length: 450 }, (_, i) => pay({ id: `res${i}`, order_id: `done${i}`, state: "needs_review", created_at: at(10 + i) }))
    const open = [0, 1, 2].map((i) => pay({ id: `open${i}`, order_id: `open${i}`, state: "needs_review", created_at: at(1000 + i) }))
    const db = storeDb({
      hubtel_wallet_payments: [...resolved, ...open],
      ussd_orders: [
        ...resolved.map((p) => ({ id: p.order_id, order_status: "completed", payment_status: "completed" })),
        ...open.map((p) => ({ id: p.order_id, order_status: "pending", payment_status: "pending" })),
      ],
    })
    const { rows, truncated } = await listHubtelWalletAttention(db, NOW)
    expect(rows.map((r) => r.paymentId).sort()).toEqual(["open0", "open1", "open2"])
    expect(truncated).toBe(false)
  })

  it("says it is truncated when more unresolved rows exist than it shows, or the page bound is hit", async () => {
    const many = Array.from({ length: 205 }, (_, i) => pay({ id: `n${i}`, order_id: `n${i}`, state: "needs_review", created_at: at(10 + i) }))
    const big = await listHubtelWalletAttention(storeDb({ hubtel_wallet_payments: many, ussd_orders: [] }), NOW)
    expect(big.rows).toHaveLength(200)
    expect(big.truncated).toBe(true)
    expect(big.rows.map((r) => r.paymentId)).toContain("n0") // newest first

    const resolved = Array.from({ length: 2000 }, (_, i) => pay({ id: `r${i}`, order_id: `r${i}`, state: "needs_review", created_at: at(10 + i) }))
    const bound = await listHubtelWalletAttention(storeDb({
      hubtel_wallet_payments: [...resolved, pay({ id: "old", order_id: "old", state: "needs_review", created_at: at(99_999) })],
      ussd_orders: resolved.map((p) => ({ id: p.order_id, order_status: "completed" })),
    }), NOW)
    expect(bound.truncated).toBe(true)
  })

  it("keeps a payment whose order cannot be found", async () => {
    const db = storeDb({ hubtel_wallet_payments: [pay({ state: "needs_review" })], ussd_orders: [] })
    expect((await listHubtelWalletAttention(db, NOW)).rows).toMatchObject([{ paymentId: "pay-1", orderStatus: null }])
  })

  it("is empty when the table does not exist yet, and throws on any other read error", async () => {
    expect(await listHubtelWalletAttention(storeDb({}, { hubtel_wallet_payments: { message: "missing", code: "PGRST205" } }), NOW)).toEqual({ rows: [], truncated: false })
    await expect(listHubtelWalletAttention(storeDb({}, { hubtel_wallet_payments: { message: "boom" } }), NOW)).rejects.toThrow()
    await expect(listHubtelWalletAttention(storeDb({ hubtel_wallet_payments: [pay({ state: "needs_review" })] }, { ussd_orders: { message: "boom" } }), NOW)).rejects.toThrow()
  })
})
