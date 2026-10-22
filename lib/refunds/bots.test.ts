import { describe, expect, it, vi } from "vitest"
import { loadRefundableOrders, listPendingOrderRefs, isStorefrontRow, isBotRow } from "./orders"
import { orderEligibility } from "./eligibility"
import { executeManualRefund, executeRefund, type RefundDeps } from "./service"
import { notifyRefund } from "./notify"
import { walletGateway } from "./gateways/wallet"
import { paystackGateway } from "./gateways/paystack"
import { paystackPayoutGateway } from "./gateways/paystack-payout"
import { moolreGateway } from "./gateways/moolre"
import { botSourceLabel, isBotOrder, type RefundableOrder, type RefundGateway } from "./types"
import { createBillOrdersAdapter, STOREFRONT_REFUND_MESSAGE, type BillOrderRow } from "@/lib/hubtel-cs/adapters/bill-orders"
import { createDataOrdersAdapter, type DataOrderRow } from "@/lib/hubtel-cs/adapters/data-orders"
import { executeBillRefund, STOREFRONT_BILL_REFUND_MESSAGE, type BillRefundDeps } from "@/lib/bills/admin-refund"
import { executeBundleRefund, STOREFRONT_BUNDLE_REFUND_MESSAGE, type BundleRefundDeps } from "@/lib/standard-bundles/admin"
import { makeTx } from "@/lib/hubtel-cs/testing/fixtures"

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: vi.fn() }) }))
const sendSMS = vi.fn(async () => ({}))
vi.mock("@/lib/sms-service", () => ({ sendSMS: (...a: unknown[]) => (sendSMS as any)(...a), notifyAdmins: vi.fn(async () => {}) }))
vi.mock("@/lib/paystack", () => ({ refundTransaction: vi.fn(), fetchRefund: vi.fn() }))
vi.mock("@/lib/moolre-transfer", () => ({ initiateTransfer: vi.fn(), getTransferStatus: vi.fn() }))
vi.mock("@/lib/paystack-transfer", () => ({
  createRecipient: vi.fn(), initiateTransfer: vi.fn(), finalizeTransfer: vi.fn(), getTransferStatus: vi.fn(),
  mapNetworkToPaystackBankCode: (n: string) => ({ MTN: "MTN", TELECEL: "VOD", AT: "ATL" } as Record<string, string>)[n.toUpperCase()],
}))

const NOW = Date.parse("2026-10-20T12:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()

type Rows = Record<string, unknown[]>
function fakeDb(rows: Rows, calls: unknown[][] = []) {
  const make = (table: string) => {
    const rec = (m: string) => (...a: unknown[]) => { calls.push([table, m, ...a]); return q }
    const q: any = {
      select: rec("select"), eq: rec("eq"), in: rec("in"), is: rec("is"), neq: rec("neq"), not: rec("not"), gte: rec("gte"),
      order: rec("order"), range: rec("range"), limit: rec("limit"), or: rec("or"),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(res),
    }
    return q
  }
  return { from: (t: string) => make(t) } as any
}

const botBill = (o: Record<string, unknown> = {}) => ({
  id: "b1", shop_id: null, user_id: null, channel: "bots", bot_surface: "whatsapp", biller: "ecg", account_number: "123456",
  amount: 10, paid_amount: 10.11, status: "failed", payment_status: "paid", hubtel_client_reference: "HCS-1", notes: null,
  buyer_phone: "233241112222", payment_reference: "PSREF", created_at: ago(600_000), updated_at: ago(600_000), ...o,
})
const failedLedger = [{ order_id: "b1", client_reference: "HCS-1", state: "failed", refund_claimed_at: null, resolved_by: null, created_at: ago(600_000) }]

describe("loadRefundableOrders: bot commission orders", () => {
  it("main bot paid via Paystack: reversal + Moolre to buyer_phone, no wallet, no Paystack payout, no owner cut", async () => {
    const calls: unknown[][] = []
    const db = fakeDb({
      hubtel_bill_orders: [botBill()],
      wallet_payments: [{ order_id: "b1", reference: "PSREF", amount: 10.11, fee: 0, status: "completed" }],
      // a recorded direct-charge payer is NOT used for bot rows: buyer_phone only
      payment_attempts: [{ reference: "PSREF", payer_phone: "+233209999999" }],
      hubtel_cs_transactions: failedLedger,
    }, calls)
    const [o] = await loadRefundableOrders(db, [{ table: "hubtel_bill_orders", id: "b1" }])
    expect(o.paid).toBe(10.11)
    expect(o.botSurface).toBe("whatsapp")
    expect(isBotOrder(o)).toBe(true)
    expect(o.payment).toEqual({ gateway: "paystack", reference: "PSREF", payerPhone: "0241112222", walletUserId: null })
    expect(o.owners).toEqual([])
    expect(o.evidence.commission?.storefront).toBe(true)
    expect(orderEligibility(o, NOW)).toEqual({ eligible: true })
    expect(paystackGateway.supports(o)).toEqual({ ok: true })
    expect(moolreGateway.supports(o)).toEqual({ ok: true })
    expect(paystackPayoutGateway.supports(o).ok).toBe(false)
    expect(walletGateway.supports(o).ok).toBe(false)
    expect(calls.some((c) => c[0] === "payment_attempts")).toBe(false)
  })

  it("Hubtel USSD rail (no wallet_payments row for its reference): Moolre payout or manual only, no Paystack reversal", async () => {
    const db = fakeDb({
      hubtel_data_orders: [{
        id: "d1", shop_id: "shopA", user_id: null, channel: "bots", bot_surface: "hubtel_ussd", network: "MTN", bundle_display: "1GB",
        beneficiary_phone: "233249999999", amount: 10, paid_amount: 10.03, status: "pending", payment_status: "paid",
        hubtel_client_reference: null, notes: null, buyer_phone: "233241112222", payment_reference: "HUBTEL-CHK-1",
        created_at: ago(600_000), updated_at: ago(600_000),
      }],
      // an unrelated abandoned Paystack attempt for the same order does not make it Paystack-paid
      wallet_payments: [{ order_id: "d1", reference: "OTHER", amount: 10.03, fee: 0, status: "pending" }],
      shop_profits: [{ shop_id: "shopA", profit_amount: 0.15, status: "credited", data_order_id: "d1" }],
      user_shops: [{ id: "shopA", shop_name: "Alpha", user_id: "uA" }],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "hubtel_data_orders", id: "d1" }])
    expect(o.payment).toEqual({ gateway: null, reference: null, payerPhone: "0241112222", walletUserId: null })
    expect(o.gatewayFee).toBe(0)
    expect(o.paid).toBe(10.03)
    expect(o.owners.map((x) => [x.shopId, x.credited])).toEqual([["shopA", 0.15]])
    expect(paystackGateway.supports(o).ok).toBe(false)
    expect(moolreGateway.supports(o)).toEqual({ ok: true })
    expect(paystackPayoutGateway.supports(o).ok).toBe(false)
    expect(walletGateway.supports(o).ok).toBe(false)
    expect(orderEligibility(o, NOW)).toEqual({ eligible: true }) // never sent, > 60 s
  })

  describe("Hubtel payment facts (hubtel_transactions)", () => {
    const ussdData = (o: Record<string, unknown> = {}) => ({
      id: "d1", shop_id: null, user_id: null, channel: "bots", bot_surface: "hubtel_ussd", network: "MTN", bundle_display: "1GB",
      beneficiary_phone: "233249999999", amount: 10, paid_amount: 10.03, status: "pending", payment_status: "paid",
      hubtel_client_reference: null, notes: null, buyer_phone: "233241112222", payment_reference: "HUBTEL-CHK-1",
      created_at: ago(600_000), updated_at: ago(600_000), ...o,
    })
    const tx = (o: Record<string, unknown> = {}) => ({
      order_id: "d1", hubtel_order_id: "HO-1", amount_paid: "10.330", amount_after_charges: "10.030", paid_at: "2026-10-20T11:00:00Z", ...o,
    })
    const load = async (rows: Record<string, unknown[]>, order = ussdData(), calls: unknown[][] = []) =>
      (await loadRefundableOrders(fakeDb({ hubtel_data_orders: [order], ...rows }, calls), [{ table: "hubtel_data_orders", id: order.id as string }]))[0]

    it("one paid transaction: payment.hubtel populated, amountPaid a number, gateway hubtel", async () => {
      const calls: unknown[][] = []
      const o = await load({ hubtel_transactions: [tx()] }, ussdData(), calls)
      expect(o.payment.gateway).toBe("hubtel")
      expect(o.payment.hubtel).toEqual({ orderId: "HO-1", amountPaid: 10.33, amountAfterCharges: 10.03, paidAt: "2026-10-20T11:00:00Z", paidRows: 1 })
      expect(calls).toContainEqual(["hubtel_transactions", "eq", "order_table", "hubtel_data_orders"])
      expect(calls).toContainEqual(["hubtel_transactions", "not", "paid_at", "is", null])
      expect(calls).toContainEqual(["hubtel_transactions", "select", "order_id, hubtel_order_id, amount_paid, amount_after_charges, paid_at"])
    })

    it("amount_after_charges null or non-numeric: amountAfterCharges null (gateway then refuses)", async () => {
      for (const v of [null, "abc"]) {
        const o = await load({ hubtel_transactions: [tx({ amount_after_charges: v })] })
        expect(o.payment.hubtel?.amountAfterCharges, String(v)).toBeNull()
        expect(o.payment.hubtel?.amountPaid).toBe(10.33)
      }
    })

    it("two paid transactions: paidRows is 2", async () => {
      const o = await load({ hubtel_transactions: [tx(), tx({ hubtel_order_id: "HO-2" })] })
      expect(o.payment.hubtel?.paidRows).toBe(2)
    })

    it("unpaid transaction (paid_at null) or no hubtel_order_id or zero amount: no hubtel, gateway stays null", async () => {
      for (const t of [tx({ paid_at: null }), tx({ hubtel_order_id: null }), tx({ amount_paid: 0 })]) {
        const o = await load({ hubtel_transactions: [t] })
        expect(o.payment.hubtel).toBeUndefined()
        expect(o.payment.gateway).toBeNull()
      }
    })

    it("a Paystack-paid row keeps gateway paystack and still carries hubtel", async () => {
      const o = await load({
        hubtel_transactions: [tx()],
        wallet_payments: [{ order_id: "d1", reference: "HUBTEL-CHK-1", amount: 10.03, fee: 0, status: "completed" }],
      })
      expect(o.payment.gateway).toBe("paystack")
      expect(o.payment.hubtel?.orderId).toBe("HO-1")
    })

    it("non-hubtel_ussd bot row and storefront row never get hubtel", async () => {
      const wa = await load({ hubtel_transactions: [tx()] }, ussdData({ bot_surface: "whatsapp" }))
      expect(wa.payment.hubtel).toBeUndefined()
      expect(wa.payment.gateway).toBeNull()
      const sf = await load({ hubtel_transactions: [tx()] }, ussdData({ channel: "storefront", bot_surface: null }))
      expect(sf.payment.hubtel).toBeUndefined()
    })
  })

  describe("Hubtel payment facts on Hubtel USSD data orders (ussd_orders / ussd_shop_orders)", () => {
    const ussdRow = (o: Record<string, unknown> = {}) => ({
      id: "u1", shop_id: null, dialing_phone: "+233241112222", recipient_phone: "+233249999999", network: "MTN", package_size: "2",
      amount: 10, order_status: "pending", payment_status: "completed", paystack_reference: null, created_at: ago(600_000), ...o,
    })
    const tx = (o: Record<string, unknown> = {}) => ({
      order_id: "u1", hubtel_order_id: "HO-U1", amount_paid: 10.3, amount_after_charges: 10, paid_at: "2026-10-20T11:00:00Z", ...o,
    })
    const load = async (table: "ussd_orders" | "ussd_shop_orders", rows: Record<string, unknown[]>, order = ussdRow(), calls: unknown[][] = []) =>
      (await loadRefundableOrders(fakeDb({ [table]: [order], ...rows }, calls), [{ table, id: order.id as string }]))[0]

    for (const table of ["ussd_orders", "ussd_shop_orders"] as const) {
      it(`${table}: one paid Hubtel tx, no Paystack ref => payment.hubtel (net + gross) and gateway hubtel`, async () => {
        const calls: unknown[][] = []
        const row = table === "ussd_shop_orders" ? ussdRow({ shop_id: "shopA" }) : ussdRow()
        const o = await load(table, { hubtel_transactions: [tx()] }, row, calls)
        expect(o.payment.gateway).toBe("hubtel")
        expect(o.payment.hubtel).toEqual({ orderId: "HO-U1", amountPaid: 10.3, amountAfterCharges: 10, paidAt: "2026-10-20T11:00:00Z", paidRows: 1 })
        expect(o.paid).toBe(10)
        expect(o.gatewayFee).toBe(0)
        expect(calls).toContainEqual(["hubtel_transactions", "eq", "order_table", table])
        expect(calls).toContainEqual(["hubtel_transactions", "not", "paid_at", "is", null])
        expect(calls).toContainEqual(["hubtel_transactions", "in", "order_id", ["u1"]])
      })

      it(`${table}: a Paystack reference keeps gateway paystack, Hubtel facts still present`, async () => {
        const o = await load(table, { hubtel_transactions: [tx()] }, ussdRow({ paystack_reference: "PS-1" }))
        expect(o.payment.gateway).toBe("paystack")
        expect(o.payment.reference).toBe("PS-1")
        expect(o.payment.hubtel?.orderId).toBe("HO-U1")
      })

      it(`${table}: unpaid / zero-amount / no Hubtel order id txs are ignored`, async () => {
        for (const t of [tx({ paid_at: null }), tx({ hubtel_order_id: null }), tx({ amount_paid: 0 }), tx({ order_id: "someone-else" })]) {
          const o = await load(table, { hubtel_transactions: [t] })
          expect(o.payment.hubtel).toBeUndefined()
          expect(o.payment.gateway).toBeNull()
        }
      })

      it(`${table}: two paid txs => paidRows 2`, async () => {
        const o = await load(table, { hubtel_transactions: [tx(), tx({ hubtel_order_id: "HO-U2" })] })
        expect(o.payment.hubtel?.paidRows).toBe(2)
      })
    }

    it("a wallet-paid USSD order stays wallet (facts attached, gateway untouched)", async () => {
      const o = await load("ussd_orders", {
        hubtel_transactions: [tx()],
        transactions: [{ reference_id: "u1", user_id: "w1", type: "debit", amount: 10 }],
      })
      expect(o.payment.gateway).toBe("wallet")
      expect(o.payment.hubtel?.orderId).toBe("HO-U1")
    })

    it("other classic tables (shop_orders, orders, api_orders) get no Hubtel facts and never query hubtel_transactions", async () => {
      const calls: unknown[][] = []
      const db = fakeDb({
        shop_orders: [{ id: "u1", shop_id: "shopA", customer_phone: "0249999999", network: "MTN", volume_gb: 2, total_price: 10, order_status: "pending", payment_status: "completed", created_at: ago(600_000) }],
        orders: [{ id: "u1", user_id: "w1", network: "MTN", size: "2", price: 10, status: "failed", phone_number: "0249999999", created_at: "2026-10-20 10:00:00" }],
        api_orders: [{ id: "u1", user_id: "w1", network: "MTN", volume_gb: 2, price: 10, status: "failed", recipient_phone: "0249999999", created_at: ago(600_000) }],
        hubtel_transactions: [tx()],
      }, calls)
      const out = await loadRefundableOrders(db, [{ table: "shop_orders", id: "u1" }, { table: "orders", id: "u1" }, { table: "api_orders", id: "u1" }])
      expect(out).toHaveLength(3)
      for (const o of out) {
        expect(o.payment.hubtel, o.table).toBeUndefined()
        expect(o.payment.gateway, o.table).not.toBe("hubtel")
      }
      expect(calls.some((c) => c[0] === "hubtel_transactions")).toBe(false)
    })
  })

  it("same eligibility rules as storefront: Hubtel ledger live blocks, never-sent waits 60 s", async () => {
    const live = fakeDb({ hubtel_bill_orders: [botBill({ status: "processing" })], hubtel_cs_transactions: [{ ...failedLedger[0], state: "pending" }] })
    const [a] = await loadRefundableOrders(live, [{ table: "hubtel_bill_orders", id: "b1" }])
    expect(orderEligibility(a, NOW)).toMatchObject({ eligible: false, code: "HUBTEL_BLOCKED" })
    const fresh = fakeDb({ hubtel_bill_orders: [botBill({ status: "pending", hubtel_client_reference: null, updated_at: ago(30_000) })] })
    const [b] = await loadRefundableOrders(fresh, [{ table: "hubtel_bill_orders", id: "b1" }])
    expect(orderEligibility(b, NOW).eligible).toBe(false)
  })

  it("isBotRow / isStorefrontRow: bots channel on bills/bundles only, never with an account", () => {
    expect(isStorefrontRow("hubtel_bill_orders", { channel: "bots", user_id: null })).toBe(true)
    expect(isStorefrontRow("hubtel_data_orders", { channel: "bots" })).toBe(true)
    expect(isStorefrontRow("hubtel_bill_orders", { channel: "bots", user_id: "u1" })).toBe(false)
    expect(isBotRow("airtime_orders", { channel: "bots" })).toBe(false)
    expect(isBotRow("hubtel_bill_orders", { channel: "storefront" })).toBe(false)
  })

  it("labels: Bot · <surface>", () => {
    expect(botSourceLabel("hubtel_ussd")).toBe("Bot · Hubtel USSD")
    expect(botSourceLabel("whatsapp_shop")).toBe("Bot · WhatsApp shop")
    expect(botSourceLabel("ussd")).toBe("Bot · USSD")
    expect(botSourceLabel(null)).toBe("Bot · unknown")
    expect(isBotOrder({})).toBe(false)
  })
})

describe("listPendingOrderRefs: bot rows", () => {
  it("lists paid bot rows (no account) next to storefront rows, with no cutoff", async () => {
    const calls: unknown[][] = []
    const db = fakeDb({ hubtel_bill_orders: [{ id: "b1", created_at: "2026-10-20T10:00:00Z" }] }, calls)
    const r = await listPendingOrderRefs(db, { pageSize: 10, page: 1, table: "hubtel_bill_orders", shopId: "shopA" })
    // the fake answers both source queries with the same row
    expect(r.map((x) => x.id)).toEqual(["b1", "b1"])
    expect(calls).toContainEqual(["hubtel_bill_orders", "eq", "channel", "storefront"])
    expect(calls).toContainEqual(["hubtel_bill_orders", "eq", "channel", "bots"])
    expect(calls).toContainEqual(["hubtel_bill_orders", "is", "user_id", null])
    expect(calls.filter((c) => c[1] === "eq" && c[2] === "shop_id")).toHaveLength(2)
    expect(calls.filter((c) => c[1] === "eq" && c[2] === "payment_status")).toHaveLength(2)
    expect(calls.some((c) => c[1] === "gte")).toBe(false)
  })
})

// ───────────────────────────── service ─────────────────────────────

const botOrder = (o: Partial<RefundableOrder> = {}): RefundableOrder => ({
  table: "hubtel_bill_orders", id: "o1", orderStatus: "failed", paymentStatus: "completed", shopId: null, shopName: null,
  botSurface: "ussd", packageLabel: "ECG bill", network: "(123)", recipientPhone: "233241112222", createdAt: ago(600_000), paid: 10.11, gatewayFee: 0,
  payment: { gateway: null, reference: null, payerPhone: "0241112222", walletUserId: null },
  owners: [],
  evidence: {
    hasActiveRefund: false, dispatchOutcome: null, dispatchAttempts: null, trackingStatuses: [], externalOrderId: null,
    commission: { storefront: true, status: "failed", paymentStatus: "paid", hubtelClientReference: null, notes: null, updatedAt: ago(600_000), ledger: [] },
  },
  ...o,
})

/** Stateful fake of the refund RPCs: one active refund per order; clawback lines only for owners with a credited share. */
function rpcSetup(initial: RefundableOrder) {
  let order = initial
  const state = { clawbacks: 0, refunds: [] as { id: string; gateway: string; status: string }[] }
  const calls: { name: string; args: any }[] = []
  const moolre: RefundGateway = { id: "moolre", label: "Moolre", supports: (o) => moolreGateway.supports(o), refund: vi.fn(async () => ({ kind: "completed" as const, ref: "M1" })) }
  const deps: RefundDeps = {
    rpc: async (name, args) => {
      calls.push({ name, args })
      if (name === "reserve_order_refund") {
        if (state.refunds.some((r) => r.status !== "failed")) return { data: null, error: { message: "ALREADY_REFUNDED" } }
        const lines = order.owners.filter((x) => x.credited > 0).map((x) => ({ shop_id: x.shopId, owner_user_id: x.ownerUserId, from_profit: x.credited, from_wallet: 0, credited: x.credited }))
        state.clawbacks += lines.length
        const id = `rf${state.refunds.length + 1}`
        state.refunds.push({ id, gateway: String(args.p_gateway), status: "reserved" })
        order = { ...order, orderStatus: "refunding", evidence: { ...order.evidence, hasActiveRefund: true } }
        return { data: { refund_id: id, clawbacks: lines }, error: null }
      }
      if (name === "complete_order_refund") {
        state.refunds.find((x) => x.id === args.p_refund_id)!.status = "completed"
        order = { ...order, orderStatus: "refunded" }
        return { data: "completed", error: null }
      }
      return { data: null, error: { message: "unexpected" } }
    },
    loadOrder: async () => order,
    getGateway: (id) => (id === "moolre" ? moolre : undefined),
    notify: vi.fn(async () => {}),
    now: () => NOW,
    findActiveRefund: async () => state.refunds.find((r) => r.status !== "failed") ?? null,
    markRefundMethod: vi.fn(async () => {}),
  }
  return { deps, calls, state, moolre }
}

const manual = { table: "hubtel_bill_orders" as const, orderId: "o1", note: "Sent back by MoMo", adminId: "admin1" }

describe("refunding bot orders", () => {
  it("bot main: Moolre payout of paid_amount to buyer_phone, no clawback", async () => {
    const s = rpcSetup(botOrder())
    const r = await executeRefund(s.deps, { table: "hubtel_bill_orders", orderId: "o1", gateway: "moolre", amount: 10.11, adminId: "a" })
    expect(r.status).toBe("completed")
    expect(s.calls[0]).toMatchObject({ name: "reserve_order_refund", args: { p_paid: 10.11, p_amount: 10.11, p_destination: "0241112222", p_wallet_user: null, p_gateway: "moolre" } })
    expect(s.state.clawbacks).toBe(0)
    expect(s.deps.notify).toHaveBeenCalledWith(expect.objectContaining({ clawbacks: [] }))
  })

  it("bot main: manual refund, no clawback, idempotent on a second click", async () => {
    const s = rpcSetup(botOrder())
    const first = await executeManualRefund(s.deps, manual)
    expect(first).toMatchObject({ refundId: "rf1", alreadyRefunded: false, message: expect.stringMatching(/no shop share/) })
    expect(s.calls[0].args).toMatchObject({ p_gateway: "manual", p_paid: 10.11, p_amount: 10.11, p_destination: null, p_wallet_user: null })
    const second = await executeManualRefund(s.deps, manual)
    expect(second).toMatchObject({ alreadyRefunded: true, refundId: null })
    expect(s.calls.filter((c) => c.name === "reserve_order_refund")).toHaveLength(1)
    expect(s.state.clawbacks).toBe(0)
  })

  it("bot shop: exactly one clawback of the credited share (manual, then a repeat click)", async () => {
    const s = rpcSetup(botOrder({ shopId: "sA", shopName: "Alpha", botSurface: "ussd_shop", owners: [{ shopId: "sA", ownerUserId: "uA", credited: 0.15, pending: 0, availableBalance: 5, walletBalance: 0 }] }))
    const r = await executeManualRefund(s.deps, manual)
    expect(r.message).toMatch(/clawed back/)
    await executeManualRefund(s.deps, manual)
    expect(s.state.clawbacks).toBe(1)
  })

  it("a bot order cannot use the Paystack MoMo payout or the wallet", async () => {
    expect(paystackPayoutGateway.supports(botOrder()).ok).toBe(false)
    expect(walletGateway.supports(botOrder()).ok).toBe(false)
    const s = rpcSetup(botOrder())
    s.deps.getGateway = (id) => (id === "paystack_payout" ? paystackPayoutGateway : undefined)
    await expect(executeRefund(s.deps, { table: "hubtel_bill_orders", orderId: "o1", gateway: "paystack_payout", amount: 1, adminId: "a" })).rejects.toMatchObject({ code: "GATEWAY_UNSUPPORTED" })
    expect(s.calls).toEqual([])
  })
})

describe("refund SMS for bot orders", () => {
  const db = { from: () => ({ insert: async () => ({ error: null }) }) } as any
  it("goes to buyer_phone only; no number => no SMS (never the recipient)", async () => {
    sendSMS.mockClear()
    await notifyRefund(db, { refundId: "rf1", order: botOrder(), amount: 10.11, gateway: "moolre", clawbacks: [] })
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(sendSMS).toHaveBeenCalledWith(expect.objectContaining({ phone: "0241112222" }))
    sendSMS.mockClear()
    await notifyRefund(db, { refundId: "rf1", order: botOrder({ recipientPhone: "0249999999", payment: { gateway: null, reference: null, payerPhone: null, walletUserId: null } }), amount: 1, gateway: "manual", clawbacks: [] })
    expect(sendSMS).not.toHaveBeenCalled()
  })
})

// ───────────────────────────── wallet paths refuse bot rows ─────────────────────────────

describe("wallet refund paths refuse bot orders", () => {
  const spies = () => ({ update: vi.fn(async () => 1), creditWallet: vi.fn(async () => {}), notify: vi.fn(async () => {}), alertAdmin: vi.fn(async () => {}) })
  const bill = (o: Partial<BillOrderRow> = {}): BillOrderRow => ({ status: "failed", payment_status: "paid", user_id: null, channel: "bots", biller: "ecg", amount: 10, paid_amount: 10.11, account_number: "123456", ...o })
  const bundle = (o: Partial<DataOrderRow> = {}): DataOrderRow => ({ status: "failed", payment_status: "paid", user_id: null, channel: "bots", network: "MTN", bundle_display: "1GB", beneficiary_phone: "233241112222", amount: 10, paid_amount: 10.03, ...o })

  it("Hubtel review queue: bill and bundle bot rows refused (even if a user_id were set), nothing credited", async () => {
    for (const row of [bill(), bill({ user_id: "u1" })]) {
      const s = spies()
      const r = await createBillOrdersAdapter({ ...s, get: async () => row }).refundToWallet!(makeTx({ order_id: "o1" }), "admin")
      expect(r).toEqual({ refunded: false, message: STOREFRONT_REFUND_MESSAGE })
      expect(s.creditWallet).not.toHaveBeenCalled()
      expect(s.update).not.toHaveBeenCalled()
    }
    for (const row of [bundle(), bundle({ user_id: "u1" })]) {
      const s = spies()
      const r = await createDataOrdersAdapter({ ...s, get: async () => row }).refundToWallet!(makeTx({ order_id: "o1" }), "admin")
      expect(r).toEqual({ refunded: false, message: STOREFRONT_REFUND_MESSAGE })
      expect(s.creditWallet).not.toHaveBeenCalled()
    }
    expect(STOREFRONT_REFUND_MESSAGE).toMatch(/bot/)
  })

  it("bills / bundles admin wallet refunds: bot rows refused before anything moves", async () => {
    const touched = vi.fn(async () => { throw new Error("must not be called") })
    const billDeps = {
      getOrder: async () => ({ id: "o1", reference_code: "BILL-1", status: "failed", payment_status: "paid", hubtel_client_reference: null, notes: null, updated_at: ago(600_000), channel: "bots", user_id: null }),
      getLedger: touched, markFailed: touched, revertToProcessing: touched, releaseStuckClaim: touched, refundViaLedger: touched, refundDirect: touched,
      alert: vi.fn(async () => {}), now: () => NOW,
    } as unknown as BillRefundDeps
    expect(await executeBillRefund(billDeps, "o1", "n", false)).toEqual({ ok: false, status: 409, message: STOREFRONT_BILL_REFUND_MESSAGE })
    expect(touched).not.toHaveBeenCalled()

    const bundleDeps = {
      getOrder: async () => ({ id: "o1", reference_code: "SB-1", user_id: "u1", amount: 10, paid_amount: 10.03, network: "MTN", bundle_display: "1GB", beneficiary_phone: "233241112222", status: "failed", payment_status: "paid", notes: null, updated_at: ago(600_000), channel: "bots" }),
      ledgerCount: touched, releaseStuckClaim: touched, claimForRefund: touched, revertToProcessing: touched, ledgerRef: touched,
      notifyRefunded: touched, creditWallet: touched, markRefunded: touched, alert: vi.fn(async () => {}), now: () => NOW,
    } as unknown as BundleRefundDeps
    expect(await executeBundleRefund(bundleDeps, "o1", "n")).toEqual({ ok: false, status: 409, message: STOREFRONT_BUNDLE_REFUND_MESSAGE })
    expect(touched).not.toHaveBeenCalled()
  })
})
