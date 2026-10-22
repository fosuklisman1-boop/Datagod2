import { describe, it, expect, vi } from "vitest"
import { dispatchBillOrder, type BillsDeps, type BillOrderRow } from "@/lib/bills/service"
import { dispatchBundleOrder, type BundlesDeps, type DataOrderRow } from "@/lib/standard-bundles/service"
import {
  confirmStorefrontOrder, settleStorefrontPayment, verifyStorefrontPayment,
  type SettleDeps, type VerifyDeps,
} from "./confirm"
import type { StorefrontOrderTable } from "./payment"

const NOW = Date.parse("2026-10-14T12:00:00Z")
const tick = () => new Promise<void>(r => setTimeout(r, 0))

type Row = Record<string, any>

function billRow(o: Row = {}): Row {
  return {
    id: "b1", reference_code: "BILL-ABC", channel: "storefront", shop_id: "shop1", user_id: null, biller: "ecg",
    account_number: "P123", phone: "0241234567", email: null, broadband_account: null, session_id: null, customer_name: "Ama",
    verified: true, amount: 100, paid_amount: 98.5, shop_share_amount: 0.75, status: "pending", payment_status: "unpaid",
    payment_reference: null, hubtel_client_reference: null, notes: null, created_at: new Date(NOW - 60_000).toISOString(), ...o,
  }
}

function bundleRow(o: Row = {}): Row {
  return {
    id: "d1", reference_code: "SB-ABC", channel: "storefront", shop_id: "shop1", user_id: null, network: "MTN",
    service_key: "data_mtn", beneficiary_phone: "233241234567", bundle_value: "V1", bundle_display: "1GB", bundle_category: "Data",
    amount: 10, paid_amount: 10.1, shop_share_amount: 0.2, status: "pending", payment_status: "unpaid", payment_reference: null,
    hubtel_client_reference: null, notes: null, created_at: new Date(NOW - 60_000).toISOString(), ...o,
  }
}

/** In-memory tables + the REAL engine dispatch (its atomic claim) wired onto them. */
function make(opts: { bills?: Row[]; bundles?: Row[]; autoFulfil?: boolean; purchaseThrows?: Error } = {}) {
  const tables: Record<StorefrontOrderTable, Row[]> = {
    hubtel_bill_orders: (opts.bills ?? [billRow()]).map(r => ({ ...r })),
    hubtel_data_orders: (opts.bundles ?? [bundleRow()]).map(r => ({ ...r })),
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
  const purchase = async (input: any) => {
    await tick()
    if (opts.purchaseThrows) throw opts.purchaseThrows
    purchases.push(input)
    return { state: "pending", client_reference: "HCS-1" } as any
  }
  const bills = {
    getOrder: async (id: string) => { await tick(); const r = find("hubtel_bill_orders", id); return r ? { ...r } as BillOrderRow : null },
    updateOrder: engineUpdate("hubtel_bill_orders"),
    purchase, alert,
  } as unknown as BillsDeps
  const bundles = {
    getOrder: async (id: string) => { await tick(); const r = find("hubtel_data_orders", id); return r ? { ...r } as DataOrderRow : null },
    updateOrder: engineUpdate("hubtel_data_orders"),
    purchase, alert,
  } as unknown as BundlesDeps

  const paymentRecords: Row[] = []
  const d: SettleDeps = {
    async getOrder(t, id) { await tick(); const r = find(t, id); return r ? { ...r } as any : null },
    async markPaid(t, id, patch) {
      await tick()
      const r = find(t, id)
      if (!r || r.channel !== "storefront" || r.payment_status !== "unpaid") return 0
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
    billsAutoFulfil: async () => opts.autoFulfil ?? true,
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

const PAY = { paidAmount: 98.5, reference: "a".repeat(32) }

describe("confirmStorefrontOrder", () => {
  it("flips, credits the shop share and dispatches once (bill)", async () => {
    const m = make()
    const r = await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)
    expect(r).toEqual({ outcome: "confirmed", status: "processing" })
    const o = m.tables.hubtel_bill_orders[0]
    expect(o.payment_status).toBe("paid")
    expect(o.payment_reference).toBe(PAY.reference)
    expect(o.paid_at).toBe(new Date(NOW).toISOString())
    expect(m.profits).toEqual([expect.objectContaining({
      shop_id: "shop1", bill_order_id: "b1", profit_amount: 0.75, status: "credited", notes: "Cashback share",
    })])
    expect(m.profits[0].data_order_id).toBeUndefined()
    expect(m.purchases).toHaveLength(1)
    expect(m.purchases[0]).toMatchObject({ amount: 100, orderTable: "hubtel_bill_orders", orderId: "b1" }) // face to Hubtel
  })

  it("bundle: data_order_id share + dispatchBundleOrder", async () => {
    const m = make()
    const r = await confirmStorefrontOrder(m.d, "hubtel_data_orders", "d1", { paidAmount: 10.1, reference: PAY.reference })
    expect(r.outcome).toBe("confirmed")
    expect(m.profits).toEqual([expect.objectContaining({ data_order_id: "d1", profit_amount: 0.2 })])
    expect(m.purchases).toEqual([expect.objectContaining({ orderTable: "hubtel_data_orders", bundle: "V1", amount: 10 })])
  })

  it("webhook + verify concurrently => 1 flip, 1 share, 1 purchase", async () => {
    const m = make()
    const vd: VerifyDeps = { ...m.d, verifyPayment: async () => { await tick(); return { status: "success", amount: 98.5, transaction_id: "t1" } } }
    const [a, b] = await Promise.all([
      settleStorefrontPayment(m.d, { table: "hubtel_bill_orders", orderId: "b1", walletPaymentId: "wp1", reference: PAY.reference, paidAmount: 98.5, transactionId: "t1" }),
      verifyStorefrontPayment(vd, "hubtel_bill_orders", { id: "wp1", status: "pending", order_id: "b1" }, PAY.reference),
      confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY),
    ])
    expect(m.flips()).toBe(1)
    expect(m.profits).toHaveLength(1)
    expect(m.purchases).toHaveLength(1)
    expect(["confirmed", "already_processed"]).toContain(a.outcome)
    expect(b.httpStatus).toBe(200)
    expect(m.alerts.filter(x => x.urgent)).toEqual([])
  })

  it("bundle webhook + verify concurrently => 1 flip, 1 share, 1 purchase", async () => {
    const m = make()
    const run = () => confirmStorefrontOrder(m.d, "hubtel_data_orders", "d1", { paidAmount: 10.1, reference: PAY.reference })
    const out = await Promise.all([run(), run(), run()])
    expect(out.filter(o => o.outcome === "confirmed")).toHaveLength(1)
    expect(m.flips()).toBe(1)
    expect(m.profits).toHaveLength(1)
    expect(m.purchases).toHaveLength(1)
  })

  it("amount mismatch => no flip, no share, no dispatch, urgent alert", async () => {
    for (const paid of [98.49, 98.51, 100, 0]) {
      const m = make()
      const r = await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", { paidAmount: paid, reference: PAY.reference })
      expect(r.outcome).toBe("amount_mismatch")
      expect(m.tables.hubtel_bill_orders[0].payment_status).toBe("unpaid")
      expect(m.flips()).toBe(0)
      expect(m.profits).toHaveLength(0)
      expect(m.purchases).toHaveLength(0)
      expect(m.alerts).toEqual([expect.objectContaining({ urgent: true })])
      expect(m.alerts[0].m).toContain("BILL-ABC")
    }
  })

  it("pesewa-exact: float noise within a pesewa is the same amount", async () => {
    const m = make({ bills: [billRow({ paid_amount: "98.50" })] })
    expect((await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", { paidAmount: 9850 / 100, reference: PAY.reference })).outcome).toBe("confirmed")
  })

  it("share 0 / null => no profit row, still dispatched", async () => {
    for (const share of [0, null]) {
      const m = make({ bills: [billRow({ shop_share_amount: share })] })
      expect((await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)).outcome).toBe("confirmed")
      expect(m.profits).toHaveLength(0)
      expect(m.purchases).toHaveLength(1)
    }
  })

  it("a duplicate shop share (23505) is ignored; another insert error alerts but still dispatches", async () => {
    const m = make()
    m.profits.push({ bill_order_id: "b1", shop_id: "shop1" })
    expect((await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)).outcome).toBe("confirmed")
    expect(m.alerts).toEqual([])
    const m2 = make()
    m2.d.insertShopProfit = async () => { throw Object.assign(new Error("boom"), { code: "XX000" }) }
    expect((await confirmStorefrontOrder(m2.d, "hubtel_bill_orders", "b1", PAY)).outcome).toBe("confirmed")
    expect(m2.purchases).toHaveLength(1)
    expect(m2.alerts.some(a => a.urgent && a.m.includes("shop share"))).toBe(true)
  })

  it("refuses a non-storefront (dashboard) order and a missing one", async () => {
    const m = make({ bills: [billRow({ channel: "dashboard", user_id: "u1" })] })
    expect((await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)).outcome).toBe("refused")
    expect((await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "nope", PAY)).outcome).toBe("refused")
    expect(m.flips()).toBe(0)
    expect(m.purchases).toHaveLength(0)
    expect(m.tables.hubtel_bill_orders[0].payment_status).toBe("unpaid")
  })

  it("replay after completion => no-op (no flip, share, purchase or alert)", async () => {
    const m = make()
    await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)
    m.tables.hubtel_bill_orders[0].status = "completed"
    const r = await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)
    expect(r).toEqual({ outcome: "already_processed", status: "completed" })
    expect(m.flips()).toBe(1)
    expect(m.profits).toHaveLength(1)
    expect(m.purchases).toHaveLength(1)
    expect(m.alerts).toEqual([])
  })

  it("a second, different payment for a paid order => urgent duplicate-payment alert, nothing else", async () => {
    const m = make()
    await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)
    const r = await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", { paidAmount: 98.5, reference: "b".repeat(32) })
    expect(r.outcome).toBe("already_processed")
    expect(m.purchases).toHaveLength(1)
    expect(m.alerts).toEqual([expect.objectContaining({ urgent: true })])
    expect(m.alerts[0].m).toContain("second Paystack payment")
  })

  it("read or flip error => outcome error, nothing changed", async () => {
    const m = make()
    m.d.getOrder = async () => { throw new Error("db down") }
    expect((await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)).outcome).toBe("error")
    const m2 = make()
    m2.d.markPaid = async () => { throw new Error("db down") }
    expect((await confirmStorefrontOrder(m2.d, "hubtel_bill_orders", "b1", PAY)).outcome).toBe("error")
    expect(m2.profits).toHaveLength(0)
    expect(m2.purchases).toHaveLength(0)
  })

  it("dispatch raising before the POST => order stays paid + pending with a 'Not sent' note", async () => {
    const m = make({ purchaseThrows: new Error("Hubtel is paused") })
    const r = await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)
    expect(r).toEqual({ outcome: "confirmed", status: "pending" })
    const o = m.tables.hubtel_bill_orders[0]
    expect(o.payment_status).toBe("paid")
    expect(o.status).toBe("pending")
    expect(o.notes).toBe("Not sent: Hubtel is paused")
    expect(m.profits).toHaveLength(1)
  })

  it("a throwing dispatch never un-flips the order", async () => {
    const m = make()
    m.d.dispatch = async () => { throw new Error("runtime") }
    const r = await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)
    expect(r.outcome).toBe("confirmed")
    expect(m.tables.hubtel_bill_orders[0].payment_status).toBe("paid")
    expect(m.alerts.some(a => a.urgent)).toBe(true)
  })

  it("Ghana Water older than 10 minutes => paid, share credited, NOT dispatched, refund note + alert", async () => {
    const m = make({ bills: [billRow({ biller: "ghana_water", email: "a@b.co", session_id: "S1", created_at: new Date(NOW - 11 * 60_000).toISOString() })] })
    const r = await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)
    expect(r).toEqual({ outcome: "confirmed", status: "pending" })
    expect(m.purchases).toHaveLength(0)
    expect(m.profits).toHaveLength(1)
    expect(m.tables.hubtel_bill_orders[0].notes).toMatch(/^Not sent: Ghana Water/)
    expect(m.alerts.some(a => a.urgent && a.m.includes("Ghana Water"))).toBe(true)
  })

  it("Ghana Water within 10 minutes is dispatched", async () => {
    const m = make({ bills: [billRow({ biller: "ghana_water", email: "a@b.co", session_id: "S1", created_at: new Date(NOW - 9 * 60_000).toISOString() })] })
    await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)
    expect(m.purchases).toHaveLength(1)
  })

  it("bills auto-fulfil off (or unreadable) => paid and left pending for manual dispatch", async () => {
    const m = make({ autoFulfil: false })
    expect(await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)).toEqual({ outcome: "confirmed", status: "pending" })
    expect(m.purchases).toHaveLength(0)
    const m2 = make()
    m2.d.billsAutoFulfil = async () => { throw new Error("cfg") }
    await confirmStorefrontOrder(m2.d, "hubtel_bill_orders", "b1", PAY)
    expect(m2.purchases).toHaveLength(0)
    // bundles ignore the bills switch
    const m3 = make({ autoFulfil: false })
    await confirmStorefrontOrder(m3.d, "hubtel_data_orders", "d1", { paidAmount: 10.1, reference: PAY.reference })
    expect(m3.purchases).toHaveLength(1)
  })

  it("paid while the order is no longer pending => not dispatched, NO shop share, urgent refund alert", async () => {
    const m = make({ bills: [billRow({ status: "failed" })] })
    const r = await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)
    expect(r).toEqual({ outcome: "confirmed", status: "failed" })
    expect(m.purchases).toHaveLength(0)
    expect(m.profits).toHaveLength(0)
    expect(m.alerts.some(a => a.urgent && a.m.includes("refund"))).toBe(true)
    // A replay stays already_processed and still credits nothing.
    expect((await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)).outcome).toBe("already_processed")
    expect(m.profits).toHaveLength(0)
  })
})

describe("decision from the flip's own row state (race with an expiry between the read and the flip)", () => {
  /** The runtime flip returns { changed, status } read from the update itself; mirror that on the fake. */
  const withRowState = (m: ReturnType<typeof make>, before?: (row: Row) => void) => {
    const real = m.d.markPaid
    m.d.markPaid = async (t, id, patch) => {
      const row = m.tables[t].find(r => r.id === id)!
      before?.(row)
      const n = (await real(t, id, patch)) as number
      return { changed: n, status: n ? row.status : null }
    }
  }

  it("storefront: no race => identical to today (one share, one dispatch, no alert)", async () => {
    const m = make()
    withRowState(m)
    expect(await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)).toEqual({ outcome: "confirmed", status: "processing" })
    expect(m.profits).toHaveLength(1)
    expect(m.purchases).toHaveLength(1)
    expect(m.alerts).toEqual([])
  })

  it("storefront: the order is failed between the read and the flip => no share, no send, urgent refund alert", async () => {
    const m = make()
    withRowState(m, row => { row.status = "failed" })
    expect(await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)).toEqual({ outcome: "confirmed", status: "failed" })
    expect(m.tables.hubtel_bill_orders[0]).toMatchObject({ payment_status: "paid", status: "failed" })
    expect(m.profits).toEqual([])
    expect(m.purchases).toHaveLength(0)
    expect(m.alerts).toEqual([expect.objectContaining({ urgent: true })])
    expect(m.alerts[0].m).toContain("while its status is failed. Not sent; refund it.")
  })
})

describe("recovery of a paid order that was never sent (I1)", () => {
  /** The flip commits but the caller sees an error (timeout) — or dies right after it. */
  const crashAfterFlip = (m: ReturnType<typeof make>) => {
    const real = m.d.markPaid
    m.d.markPaid = async (...a) => { await real(...a); throw new Error("timeout") }
    return () => { m.d.markPaid = real }
  }
  const settle = (m: ReturnType<typeof make>, o: Partial<Parameters<typeof settleStorefrontPayment>[1]> = {}) =>
    settleStorefrontPayment(m.d, { table: "hubtel_bill_orders", orderId: "b1", walletPaymentId: "wp1", reference: PAY.reference, paidAmount: 98.5, transactionId: "t1", ...o })

  it("flip committed then crash => a later webhook retry completes share + dispatch exactly once", async () => {
    const m = make()
    const restore = crashAfterFlip(m)
    expect((await settle(m)).outcome).toBe("error")
    restore()
    expect(m.tables.hubtel_bill_orders[0].payment_status).toBe("paid")
    expect(m.profits).toHaveLength(0)
    expect(m.purchases).toHaveLength(0)
    expect(m.paymentRecords).toHaveLength(0)

    expect(await settle(m)).toEqual({ outcome: "resumed", status: "processing" })
    expect(m.profits).toHaveLength(1)
    expect(m.purchases).toHaveLength(1)
    expect(m.paymentRecords).toHaveLength(1)
    // later replays are plain no-ops
    expect((await settle(m)).outcome).toBe("already_processed")
    expect(m.profits).toHaveLength(1)
    expect(m.purchases).toHaveLength(1)
  })

  it("a later /api/payments/verify also recovers it", async () => {
    const m = make()
    const restore = crashAfterFlip(m)
    await settle(m)
    restore()
    const vd: VerifyDeps = { ...m.d, verifyPayment: async () => ({ status: "success", amount: 98.5, transaction_id: "t1" }) }
    expect((await verifyStorefrontPayment(vd, "hubtel_bill_orders", { id: "wp1", status: "pending", order_id: "b1" }, PAY.reference)).httpStatus).toBe(200)
    expect(m.profits).toHaveLength(1)
    expect(m.purchases).toHaveLength(1)
  })

  it("concurrent retries of a stranded order => one share, one POST (bill and bundle)", async () => {
    const m = make()
    m.tables.hubtel_bill_orders[0].payment_status = "paid"
    m.tables.hubtel_bill_orders[0].payment_reference = PAY.reference
    const out = await Promise.all([settle(m), settle(m), confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)])
    expect(out.filter(o => o.outcome === "resumed").length).toBeGreaterThanOrEqual(1)
    expect(m.profits).toHaveLength(1)
    expect(m.purchases).toHaveLength(1)

    const b = make()
    Object.assign(b.tables.hubtel_data_orders[0], { payment_status: "paid", payment_reference: PAY.reference })
    const run = () => confirmStorefrontOrder(b.d, "hubtel_data_orders", "d1", { paidAmount: 10.1, reference: PAY.reference })
    await Promise.all([run(), run(), run()])
    expect(b.profits).toHaveLength(1)
    expect(b.purchases).toHaveLength(1)
  })

  it("racing the flipper itself (flip done, dispatch not yet) => still one POST", async () => {
    const m = make()
    const real = m.d.dispatch
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    m.d.dispatch = async (...a) => { await gate; return real(...a) }
    const first = confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)
    await new Promise(r => setTimeout(r, 20))
    const second = confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)
    await new Promise(r => setTimeout(r, 20))
    release()
    await Promise.all([first, second])
    expect(m.purchases).toHaveLength(1)
    expect(m.profits).toHaveLength(1)
  })

  it("not re-run when the order was attempted (note), has a ledger row, or was paid by another reference", async () => {
    for (const o of [{ notes: "Not sent: Hubtel is paused" }, { notes: "Dispatching…" }, { hubtel_client_reference: "HCS-9" }]) {
      const m = make({ bills: [billRow({ payment_status: "paid", payment_reference: PAY.reference, ...o })] })
      expect((await settle(m)).outcome).toBe("already_processed")
      expect(m.purchases).toHaveLength(0)
      expect(m.profits).toHaveLength(0)
    }
    const led = make({ bills: [billRow({ payment_status: "paid", payment_reference: PAY.reference })] })
    led.d.hasLedgerRow = async () => true
    expect((await settle(led)).outcome).toBe("already_processed")
    expect(led.purchases).toHaveLength(0)

    const other = make({ bills: [billRow({ payment_status: "paid", payment_reference: "c".repeat(32) })] })
    expect((await settle(other)).outcome).toBe("already_processed")
    expect(other.purchases).toHaveLength(0)
    expect(other.alerts[0].m).toContain("second Paystack payment")
  })

  it("ledger unreadable => no dispatch, urgent alert", async () => {
    const m = make({ bills: [billRow({ payment_status: "paid", payment_reference: PAY.reference })] })
    m.d.hasLedgerRow = async () => { throw new Error("db") }
    expect((await settle(m)).outcome).toBe("already_processed")
    expect(m.purchases).toHaveLength(0)
    expect(m.alerts.some(a => a.urgent && a.m.includes("ledger"))).toBe(true)
  })

  it("manual-dispatch (auto-fulfil off) orders are noted once, so retries neither dispatch nor re-alert", async () => {
    const m = make({ autoFulfil: false })
    await settle(m)
    await settle(m)
    await confirmStorefrontOrder(m.d, "hubtel_bill_orders", "b1", PAY)
    expect(m.tables.hubtel_bill_orders[0].notes).toBe("Awaiting manual dispatch")
    expect(m.purchases).toHaveLength(0)
    expect(m.alerts).toHaveLength(1)
  })
})

describe("payment-level alerts come from the webhook only (M2)", () => {
  const vd = (m: ReturnType<typeof make>, amount: number) =>
    ({ ...m.d, verifyPayment: async () => ({ status: "success", amount, transaction_id: "t1" }) }) as VerifyDeps
  const pay = { id: "wp1", status: "pending", order_id: "b1" }

  it("verify: amount mismatch, refused and duplicate payment send no alert, however often it is called", async () => {
    const m = make()
    for (let i = 0; i < 3; i++) {
      expect((await verifyStorefrontPayment(vd(m, 1), "hubtel_bill_orders", pay, PAY.reference)).httpStatus).toBe(400)
    }
    const r = make({ bills: [billRow({ channel: "dashboard" })] })
    await verifyStorefrontPayment(vd(r, 98.5), "hubtel_bill_orders", pay, PAY.reference)
    await verifyStorefrontPayment(vd(r, 98.5), "hubtel_bill_orders", { ...pay, order_id: null }, PAY.reference)
    const dup = make({ bills: [billRow({ payment_status: "paid", payment_reference: "c".repeat(32), status: "completed" })] })
    await verifyStorefrontPayment(vd(dup, 98.5), "hubtel_bill_orders", pay, PAY.reference)
    expect([...m.alerts, ...r.alerts, ...dup.alerts]).toEqual([])
  })

  it("webhook: the same cases alert urgently", async () => {
    const m = make()
    await settleStorefrontPayment(m.d, { table: "hubtel_bill_orders", orderId: "b1", walletPaymentId: "wp1", reference: PAY.reference, paidAmount: 1, transactionId: null })
    expect(m.alerts).toEqual([expect.objectContaining({ urgent: true })])
  })
})

describe("Ghana Water age from verified_at (M3)", () => {
  it("measures from verified_at when set, else created_at", async () => {
    const gw = { biller: "ghana_water", email: "a@b.co", session_id: "S1" }
    const old = make({ bills: [billRow({ ...gw, verified_at: new Date(NOW - 11 * 60_000).toISOString(), created_at: new Date(NOW - 60_000).toISOString() })] })
    await confirmStorefrontOrder(old.d, "hubtel_bill_orders", "b1", PAY)
    expect(old.purchases).toHaveLength(0)
    expect(old.tables.hubtel_bill_orders[0].notes).toMatch(/^Not sent: Ghana Water/)

    const fresh = make({ bills: [billRow({ ...gw, verified_at: new Date(NOW - 9 * 60_000).toISOString(), created_at: new Date(NOW - 60_000).toISOString() })] })
    await confirmStorefrontOrder(fresh.d, "hubtel_bill_orders", "b1", PAY)
    expect(fresh.purchases).toHaveLength(1)

    const legacy = make({ bills: [billRow({ ...gw, verified_at: null, created_at: new Date(NOW - 11 * 60_000).toISOString() })] })
    await confirmStorefrontOrder(legacy.d, "hubtel_bill_orders", "b1", PAY)
    expect(legacy.purchases).toHaveLength(0)
  })
})

describe("settleStorefrontPayment", () => {
  const base = { table: "hubtel_bill_orders" as const, orderId: "b1", walletPaymentId: "wp1", reference: PAY.reference, paidAmount: 98.5, transactionId: "t1" }

  it("completes the payment records only once the order is paid", async () => {
    const m = make()
    expect((await settleStorefrontPayment(m.d, base)).outcome).toBe("confirmed")
    expect(m.paymentRecords).toEqual([expect.objectContaining({ walletPaymentId: "wp1", reference: PAY.reference, paidAmount: 98.5 })])
    const mm = make()
    expect((await settleStorefrontPayment(mm.d, { ...base, paidAmount: 1 })).outcome).toBe("amount_mismatch")
    expect(mm.paymentRecords).toEqual([])
  })

  it("no order attached / not a storefront order => urgent alert, nothing processed", async () => {
    const m = make({ bills: [billRow({ channel: "dashboard" })] })
    expect((await settleStorefrontPayment(m.d, { ...base, orderId: null })).outcome).toBe("refused")
    expect((await settleStorefrontPayment(m.d, base)).outcome).toBe("refused")
    expect(m.alerts.filter(a => a.urgent)).toHaveLength(2)
    expect(m.paymentRecords).toEqual([])
    expect(m.purchases).toHaveLength(0)
  })
})

describe("verifyStorefrontPayment", () => {
  const vd = (m: ReturnType<typeof make>, v: { status: string; amount: number }) => {
    const verifyPayment = vi.fn(async () => ({ ...v, transaction_id: "t1" }))
    return { d: { ...m.d, verifyPayment } as VerifyDeps, verifyPayment }
  }
  const pay = { id: "wp1", status: "pending", order_id: "b1" }

  it("already completed payment record => no Paystack call", async () => {
    const m = make(); const { d, verifyPayment } = vd(m, { status: "success", amount: 98.5 })
    const r = await verifyStorefrontPayment(d, "hubtel_bill_orders", { ...pay, status: "completed" }, PAY.reference)
    expect(r.body).toMatchObject({ success: true, status: "completed" })
    expect(verifyPayment).not.toHaveBeenCalled()
  })

  it("Paystack not successful => nothing changes", async () => {
    const m = make(); const { d } = vd(m, { status: "failed", amount: 98.5 })
    const r = await verifyStorefrontPayment(d, "hubtel_bill_orders", pay, PAY.reference)
    expect(r).toMatchObject({ httpStatus: 200, body: { status: "failed" } })
    expect(m.flips()).toBe(0)
  })

  it("success => confirmed; mismatch => 400", async () => {
    const m = make(); const { d } = vd(m, { status: "success", amount: 98.5 })
    expect(await verifyStorefrontPayment(d, "hubtel_bill_orders", pay, PAY.reference)).toMatchObject({ httpStatus: 200, body: { success: true, status: "success" } })
    expect(m.purchases).toHaveLength(1)
    const m2 = make(); const v2 = vd(m2, { status: "success", amount: 50 })
    expect(await verifyStorefrontPayment(v2.d, "hubtel_bill_orders", pay, PAY.reference)).toMatchObject({ httpStatus: 400, body: { success: false } })
    expect(m2.flips()).toBe(0)
  })
})
