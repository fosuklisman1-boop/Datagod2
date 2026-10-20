import { describe, it, expect } from "vitest"
import { dispatchBillOrder, type BillsDeps, type BillOrderRow } from "@/lib/bills/service"
import { dispatchBundleOrder, type BundlesDeps, type DataOrderRow } from "@/lib/standard-bundles/service"
import {
  confirmBotOrder, confirmCommissionOrder, confirmStorefrontOrder, settleStorefrontPayment, verifyStorefrontPayment,
  type SettleDeps, type VerifyDeps,
} from "./confirm"
import { botPaymentEmail, checkCommissionPayable, DEFAULT_BOT_PAYMENT_EMAIL, isStorefrontOrderType, STOREFRONT_ORDER_TABLE } from "./payment"
import type { StorefrontOrderTable } from "./payment"

// Bot (channel 'bots') bill / bundle orders through the shared commission confirmation. Same fake-world pattern as
// confirm.test.ts: in-memory tables, the REAL engine dispatch (its atomic claim), a guarded markPaid that only flips
// commission rows (storefront | bots) that are still unpaid.

const NOW = Date.parse("2026-10-14T12:00:00Z")
const tick = () => new Promise<void>(r => setTimeout(r, 0))
type Row = Record<string, any>

/** Main-bot bill: no shop, share stored as 0 (Task 3 snapshot). */
function botBill(o: Row = {}): Row {
  return {
    id: "b1", reference_code: "BILL-BOT", channel: "bots", bot_surface: "whatsapp", shop_id: null, user_id: null, biller: "ecg",
    account_number: "P123", phone: "0241234567", email: null, broadband_account: null, session_id: null, customer_name: "Ama",
    verified: true, amount: 10, paid_amount: 10.11, shop_share_amount: 0, buyer_phone: "233241234567", buyer_email: null,
    status: "pending", payment_status: "unpaid", payment_reference: null, hubtel_client_reference: null, notes: null,
    created_at: new Date(NOW - 60_000).toISOString(), ...o,
  }
}

/** Shop-bot bundle: shop share 0.15 (Task 1 example: GHS 10 MTN, hubtel fee 1 % => pay 10.03). */
function botBundle(o: Row = {}): Row {
  return {
    id: "d1", reference_code: "SB-BOT", channel: "bots", bot_surface: "ussd_shop", shop_id: "shop1", user_id: null, network: "MTN",
    service_key: "data_mtn", beneficiary_phone: "233241234567", bundle_value: "V1", bundle_display: "1GB", bundle_category: "Data",
    amount: 10, paid_amount: 10.03, shop_share_amount: 0.15, buyer_phone: "233241234567", buyer_email: null,
    status: "pending", payment_status: "unpaid", payment_reference: null, hubtel_client_reference: null, notes: null,
    created_at: new Date(NOW - 60_000).toISOString(), ...o,
  }
}

function make(opts: { bills?: Row[]; bundles?: Row[] } = {}) {
  const tables: Record<StorefrontOrderTable, Row[]> = {
    hubtel_bill_orders: (opts.bills ?? [botBill()]).map(r => ({ ...r })),
    hubtel_data_orders: (opts.bundles ?? [botBundle()]).map(r => ({ ...r })),
  }
  const profits: Row[] = []
  const purchases: any[] = []
  const alerts: { m: string; urgent: boolean }[] = []
  let flips = 0
  const find = (t: StorefrontOrderTable, id: string) => tables[t].find(r => r.id === id) ?? null
  const alert = async (m: string, urgent = false) => { alerts.push({ m, urgent }) }
  const engineUpdate = (t: StorefrontOrderTable) => async (id: string, patch: Row, from?: string[], pay?: string) => {
    await tick()
    const r = find(t, id)
    if (!r || (from && !from.includes(r.status)) || (pay && r.payment_status !== pay)) return 0
    Object.assign(r, patch)
    return 1
  }
  const purchase = async (input: any) => { await tick(); purchases.push(input); return { state: "pending", client_reference: "HCS-1" } as any }
  const bills = {
    getOrder: async (id: string) => { await tick(); const r = find("hubtel_bill_orders", id); return r ? { ...r } as BillOrderRow : null },
    updateOrder: engineUpdate("hubtel_bill_orders"), purchase, alert,
  } as unknown as BillsDeps
  const bundles = {
    getOrder: async (id: string) => { await tick(); const r = find("hubtel_data_orders", id); return r ? { ...r } as DataOrderRow : null },
    updateOrder: engineUpdate("hubtel_data_orders"), purchase, alert,
  } as unknown as BundlesDeps
  const paymentRecords: Row[] = []
  const d: SettleDeps = {
    async getOrder(t, id) { await tick(); const r = find(t, id); return r ? { ...r } as any : null },
    async markPaid(t, id, patch) {
      await tick()
      const r = find(t, id)
      if (!r || !["storefront", "bots"].includes(r.channel) || r.payment_status !== "unpaid") return 0
      Object.assign(r, { payment_status: "paid", ...patch })
      flips++
      return 1
    },
    async insertShopProfit(row) {
      await tick()
      const fk = row.bill_order_id ? "bill_order_id" : "data_order_id"
      if (profits.some(p => p[fk] === row[fk] && p.shop_id === row.shop_id)) throw Object.assign(new Error("dup"), { code: "23505" })
      profits.push(row)
    },
    billsAutoFulfil: async () => true,
    async dispatch(t, id) {
      if (t === "hubtel_bill_orders") { const f = await bills.getOrder(id); return f ? dispatchBillOrder(bills, f) : "missing" }
      const f = await bundles.getOrder(id); return f ? dispatchBundleOrder(bundles, f) : "missing"
    },
    async setPendingNote(t, id, notes) { await tick(); const r = find(t, id); if (!r || r.status !== "pending" || r.notes) return 0; r.notes = notes; return 1 },
    async hasLedgerRow(t, id) { await tick(); return purchases.some(p => p.orderTable === t && p.orderId === id) },
    alert,
    now: () => NOW,
    async completePaymentRecords(p) { paymentRecords.push(p) },
  }
  return { d, tables, profits, purchases, alerts, paymentRecords, flips: () => flips }
}

const REF = "c".repeat(32)
const BILL_PAY = { paidAmount: 10.11, reference: REF }
const BUNDLE_PAY = { paidAmount: 10.03, reference: REF }

describe("confirmCommissionOrder: bot orders", () => {
  it("keeps confirmStorefrontOrder as an alias", () => {
    expect(confirmStorefrontOrder).toBe(confirmCommissionOrder)
  })

  it("main bot (no shop, share 0): flipped and dispatched once, NO shop_profits row", async () => {
    const m = make()
    const r = await confirmCommissionOrder(m.d, "hubtel_bill_orders", "b1", BILL_PAY)
    expect(r).toEqual({ outcome: "confirmed", status: "processing" })
    expect(m.tables.hubtel_bill_orders[0]).toMatchObject({ payment_status: "paid", payment_reference: REF })
    expect(m.profits).toEqual([])
    expect(m.purchases).toHaveLength(1)
    expect(m.purchases[0]).toMatchObject({ amount: 10, orderTable: "hubtel_bill_orders", orderId: "b1" }) // face to Hubtel
    expect(m.alerts).toEqual([])
  })

  it("main bot with a stray share amount but no shop => still no share row", async () => {
    const m = make({ bills: [botBill({ shop_share_amount: 0.2 })] })
    expect((await confirmCommissionOrder(m.d, "hubtel_bill_orders", "b1", BILL_PAY)).outcome).toBe("confirmed")
    expect(m.profits).toEqual([])
  })

  it("shop bot: exactly one shop_profits row with the snapshot share", async () => {
    const m = make()
    const r = await confirmCommissionOrder(m.d, "hubtel_data_orders", "d1", BUNDLE_PAY)
    expect(r.outcome).toBe("confirmed")
    expect(m.profits).toEqual([expect.objectContaining({
      shop_id: "shop1", data_order_id: "d1", profit_amount: 0.15, status: "credited", notes: "Cashback share",
    })])
    expect(m.purchases).toEqual([expect.objectContaining({ orderTable: "hubtel_data_orders", bundle: "V1", amount: 10 })])
  })

  it("shop bot with share 0 => no share row", async () => {
    const m = make({ bundles: [botBundle({ shop_share_amount: 0 })] })
    expect((await confirmCommissionOrder(m.d, "hubtel_data_orders", "d1", BUNDLE_PAY)).outcome).toBe("confirmed")
    expect(m.profits).toEqual([])
    expect(m.purchases).toHaveLength(1)
  })

  it("double confirm (webhook + verify + bot callback concurrently) => one flip, one share, one POST", async () => {
    const m = make()
    const vd: VerifyDeps = { ...m.d, verifyPayment: async () => { await tick(); return { status: "success", amount: 10.03, transaction_id: "t1" } } }
    const [a, b, c] = await Promise.all([
      settleStorefrontPayment(m.d, { table: "hubtel_data_orders", orderId: "d1", walletPaymentId: "wp1", reference: REF, paidAmount: 10.03, transactionId: "t1" }),
      verifyStorefrontPayment(vd, "hubtel_data_orders", { id: "wp1", status: "pending", order_id: "d1" }, REF),
      confirmBotOrder(m.d, "hubtel_data_orders", "d1", BUNDLE_PAY),
    ])
    expect(m.flips()).toBe(1)
    expect(m.profits).toHaveLength(1)
    expect(m.purchases).toHaveLength(1)
    expect([a.outcome, c.outcome].filter(o => o === "confirmed").length).toBeLessThanOrEqual(1)
    expect(b.httpStatus).toBe(200)
    expect(m.alerts.filter(x => x.urgent)).toEqual([])
    // a later replay is a no-op
    expect((await confirmBotOrder(m.d, "hubtel_data_orders", "d1", BUNDLE_PAY)).outcome).toBe("already_processed")
    expect(m.purchases).toHaveLength(1)
  })

  it("amount mismatch (pesewa-exact) => left unpaid, nothing sent, one urgent alert naming no rail", async () => {
    for (const paid of [10.1, 10.12, 10, 0]) {
      const m = make()
      const r = await confirmCommissionOrder(m.d, "hubtel_bill_orders", "b1", { paidAmount: paid, reference: REF })
      expect(r.outcome).toBe("amount_mismatch")
      expect(m.tables.hubtel_bill_orders[0].payment_status).toBe("unpaid")
      expect(m.flips()).toBe(0)
      expect(m.profits).toHaveLength(0)
      expect(m.purchases).toHaveLength(0)
      expect(m.alerts).toEqual([expect.objectContaining({ urgent: true })])
      expect(m.alerts[0].m).toContain("bot order BILL-BOT")
      expect(m.alerts[0].m).not.toContain("Paystack")
    }
    const quiet = make()
    expect((await confirmBotOrder(quiet.d, "hubtel_bill_orders", "b1", { paidAmount: 1, reference: REF, alertPaymentIssues: false })).outcome).toBe("amount_mismatch")
    expect(quiet.alerts).toEqual([])
  })

  it("flip committed then crash => a later retry resumes: one share, one POST; then no-op", async () => {
    const m = make()
    const real = m.d.markPaid
    m.d.markPaid = async (...a) => { await real(...a); throw new Error("timeout") }
    expect((await confirmBotOrder(m.d, "hubtel_data_orders", "d1", BUNDLE_PAY)).outcome).toBe("error")
    m.d.markPaid = real
    expect(m.tables.hubtel_data_orders[0].payment_status).toBe("paid")
    expect(m.profits).toHaveLength(0)
    expect(m.purchases).toHaveLength(0)

    const out = await Promise.all([
      confirmBotOrder(m.d, "hubtel_data_orders", "d1", BUNDLE_PAY),
      confirmBotOrder(m.d, "hubtel_data_orders", "d1", BUNDLE_PAY),
    ])
    expect(out.some(o => o.outcome === "resumed")).toBe(true)
    expect(m.profits).toHaveLength(1)
    expect(m.purchases).toHaveLength(1)
    expect((await confirmBotOrder(m.d, "hubtel_data_orders", "d1", BUNDLE_PAY)).outcome).toBe("already_processed")
    expect(m.flips()).toBe(1)
  })

  it("a second, different payment for a paid bot order => urgent duplicate alert, nothing else", async () => {
    const m = make()
    await confirmBotOrder(m.d, "hubtel_bill_orders", "b1", BILL_PAY)
    const r = await confirmBotOrder(m.d, "hubtel_bill_orders", "b1", { paidAmount: 10.11, reference: "d".repeat(32) })
    expect(r.outcome).toBe("already_processed")
    expect(m.purchases).toHaveLength(1)
    expect(m.alerts).toEqual([expect.objectContaining({ urgent: true })])
    expect(m.alerts[0].m).toContain("second payment")
  })

  it("shop bot paid after it was failed => flipped paid, NOT sent, NO shop share, urgent refund alert", async () => {
    const m = make({ bundles: [botBundle({ status: "failed" })] })
    const r = await confirmBotOrder(m.d, "hubtel_data_orders", "d1", BUNDLE_PAY)
    expect(r).toEqual({ outcome: "confirmed", status: "failed" })
    expect(m.tables.hubtel_data_orders[0]).toMatchObject({ payment_status: "paid", status: "failed" })
    expect(m.purchases).toHaveLength(0)
    expect(m.profits).toEqual([])
    expect(m.alerts.some(a => a.urgent && a.m.includes("refund"))).toBe(true)
    // A replay of the same payment credits nothing either.
    expect((await confirmBotOrder(m.d, "hubtel_data_orders", "d1", BUNDLE_PAY)).outcome).toBe("already_processed")
    expect(m.profits).toEqual([])
  })

  it("confirmBotOrder refuses storefront and dashboard rows; confirmCommissionOrder refuses dashboard", async () => {
    const sf = make({ bills: [botBill({ channel: "storefront", shop_id: "shop1" })] })
    expect((await confirmBotOrder(sf.d, "hubtel_bill_orders", "b1", BILL_PAY)).outcome).toBe("refused")
    expect(sf.flips()).toBe(0)
    const dash = make({ bills: [botBill({ channel: "dashboard", user_id: "u1" })] })
    expect((await confirmBotOrder(dash.d, "hubtel_bill_orders", "b1", BILL_PAY)).outcome).toBe("refused")
    expect((await confirmCommissionOrder(dash.d, "hubtel_bill_orders", "b1", BILL_PAY)).outcome).toBe("refused")
    expect((await confirmBotOrder(dash.d, "hubtel_bill_orders", "nope", BILL_PAY)).outcome).toBe("refused")
    expect(dash.flips()).toBe(0)
    expect(dash.purchases).toHaveLength(0)
  })

  it("the Paystack settle path completes payment records for a bot order", async () => {
    const m = make()
    const r = await settleStorefrontPayment(m.d, { table: "hubtel_bill_orders", orderId: "b1", walletPaymentId: "wp1", reference: REF, paidAmount: 10.11, transactionId: "t1" })
    expect(r.outcome).toBe("confirmed")
    expect(m.paymentRecords).toEqual([expect.objectContaining({ walletPaymentId: "wp1", reference: REF, paidAmount: 10.11 })])
  })
})

// Bots Plan 3 proof: a shop-USSD (Uzo) order charged by botChargeMomo writes a cs_bundle wallet_payments row; the
// existing Paystack webhook resolves reference -> wallet_payments -> STOREFRONT_ORDER_TABLE[order_type] ->
// settleStorefrontPayment (app/api/webhooks/paystack/route.ts, settleStorefrontWebhook). No production change.
describe("Uzo shop USSD (bot_surface ussd_shop) paid through a cs_bundle wallet_payments row", () => {
  const WALLET_ROW = { id: "wp-ussd", reference: REF, order_type: "cs_bundle", order_id: "d1", status: "pending" }

  /** The webhook's storefront branch, step for step (charge.success, amount in pesewas). */
  async function webhook(d: SettleDeps, wallet: typeof WALLET_ROW, pesewas: number) {
    if (!isStorefrontOrderType(wallet.order_type)) throw new Error("not a storefront order type")
    return settleStorefrontPayment(d, {
      table: STOREFRONT_ORDER_TABLE[wallet.order_type], orderId: wallet.order_id, walletPaymentId: wallet.id, reference: REF,
      paidAmount: Math.round(pesewas) / 100, transactionId: "t1", gatewayResponse: "success",
    })
  }

  it("one paid flip, one shop share, one dispatch; a second identical webhook is already_processed", async () => {
    const m = make({ bundles: [botBundle({ bot_surface: "ussd_shop" })] })
    const first = await webhook(m.d, WALLET_ROW, 1003)
    expect(first.outcome).toBe("confirmed")
    expect(m.flips()).toBe(1)
    expect(m.tables.hubtel_data_orders[0]).toMatchObject({ payment_status: "paid", payment_reference: REF, bot_surface: "ussd_shop" })
    expect(m.profits).toEqual([expect.objectContaining({ shop_id: "shop1", data_order_id: "d1", profit_amount: 0.15 })])
    expect(m.purchases).toHaveLength(1)
    expect(m.paymentRecords).toEqual([expect.objectContaining({ walletPaymentId: "wp-ussd", reference: REF, paidAmount: 10.03 })])

    const again = await webhook(m.d, WALLET_ROW, 1003)
    expect(again.outcome).toBe("already_processed")
    expect(m.flips()).toBe(1)
    expect(m.profits).toHaveLength(1)
    expect(m.purchases).toHaveLength(1)
    expect(m.alerts.filter(a => a.urgent)).toEqual([])
  })

  it("verifyStorefrontPayment racing the webhook => the same single effect", async () => {
    const m = make({ bundles: [botBundle({ bot_surface: "ussd_shop" })] })
    const vd: VerifyDeps = { ...m.d, verifyPayment: async () => { await tick(); return { status: "success", amount: 10.03, transaction_id: "t1" } } }
    const [w, v] = await Promise.all([
      webhook(m.d, WALLET_ROW, 1003),
      verifyStorefrontPayment(vd, STOREFRONT_ORDER_TABLE.cs_bundle, { id: WALLET_ROW.id, status: "pending", order_id: "d1" }, REF),
    ])
    expect(["confirmed", "already_processed"]).toContain(w.outcome)
    expect(v.httpStatus).toBe(200)
    expect(m.flips()).toBe(1)
    expect(m.profits).toHaveLength(1)
    expect(m.purchases).toHaveLength(1)
    expect(m.alerts.filter(a => a.urgent)).toEqual([])
    // and a late webhook replay after both
    expect((await webhook(m.d, WALLET_ROW, 1003)).outcome).toBe("already_processed")
    expect(m.purchases).toHaveLength(1)
  })
})

describe("checkCommissionPayable / botPaymentEmail", () => {
  const bot = (o: Row = {}) => ({
    channel: "bots", shop_id: null, status: "pending", payment_status: "unpaid", paid_amount: 10.11, buyer_email: null,
    buyer_phone: "233241234567", ...o,
  })

  it("bot row: paid_amount, neutral fallback email, per-phone cap key, no slug needed", () => {
    expect(checkCommissionPayable(bot(), null)).toEqual({
      ok: true, amount: 10.11, email: DEFAULT_BOT_PAYMENT_EMAIL, shopId: null, bot: true, capKey: "p:233241234567",
    })
    expect(checkCommissionPayable(bot({ shop_id: "shop1" }), null)).toMatchObject({ ok: true, shopId: "shop1" })
    expect(checkCommissionPayable(bot({ buyer_email: " a@b.co " }), null)).toMatchObject({ ok: true, email: "a@b.co" })
  })

  it("bot row: refused when not pending/unpaid, wrong shop, bad amount or no phone", () => {
    expect(checkCommissionPayable(bot({ payment_status: "paid" }), null)).toMatchObject({ ok: false, status: 400 })
    expect(checkCommissionPayable(bot({ status: "failed" }), null)).toMatchObject({ ok: false, status: 400 })
    expect(checkCommissionPayable(bot(), "shop1")).toMatchObject({ ok: false, status: 400 })
    expect(checkCommissionPayable(bot({ paid_amount: null }), null)).toMatchObject({ ok: false, status: 500 })
    expect(checkCommissionPayable(bot({ paid_amount: 0 }), null)).toMatchObject({ ok: false, status: 500 })
    expect(checkCommissionPayable(bot({ buyer_phone: null }), null)).toMatchObject({ ok: false, status: 500 })
  })

  it("storefront row: exactly the storefront check (shop required, buyer email)", () => {
    const sf = bot({ channel: "storefront", shop_id: "shop1", buyer_email: "B@x.co" })
    expect(checkCommissionPayable(sf, "shop1")).toEqual({ ok: true, amount: 10.11, email: "B@x.co", shopId: "shop1", bot: false, capKey: "e:b@x.co" })
    expect(checkCommissionPayable(sf, null)).toMatchObject({ ok: false, status: 400 })
    expect(checkCommissionPayable({ ...sf, buyer_email: null }, "shop1")).toMatchObject({ ok: false, status: 500 })
    expect(checkCommissionPayable(bot({ channel: "dashboard" }), null)).toMatchObject({ ok: false, status: 400 })
    expect(checkCommissionPayable(null, null)).toMatchObject({ ok: false, status: 400 })
  })

  it("botPaymentEmail: env override when it is an email, else the default", () => {
    expect(botPaymentEmail(undefined)).toBe("payments@datagod.store")
    expect(botPaymentEmail("")).toBe("payments@datagod.store")
    expect(botPaymentEmail("not-an-email")).toBe("payments@datagod.store")
    expect(botPaymentEmail(" pay@example.com ")).toBe("pay@example.com")
    expect(botPaymentEmail()).toMatch(/@/)
    // local part names no product (the domain is the brand's own)
    expect(DEFAULT_BOT_PAYMENT_EMAIL.split("@")[0]).not.toMatch(/bill|bundle|data|airtime|cashback|commission/i)
  })
})
