import { describe, it, expect } from "vitest"
import { verifyBill, payBill, dispatchBillOrder, type BillsDeps, type BillOrderRow } from "./service"
import { resolveBillsConfig, type BillsConfig } from "./config"
import { BILLER_KEYS } from "./billers"
import { HubtelPausedError, HubtelOutcomeUnknownError } from "@/lib/hubtel-cs/errors"
import type { HubtelCsTx } from "@/lib/hubtel-cs/types"

const allOn = (): BillsConfig =>
  resolveBillsConfig({ enabled: true, billers: Object.fromEntries(BILLER_KEYS.map(k => [k, { enabled: true, min: 5, max: 1000 }])) })

function make(over: Partial<BillsDeps> = {}) {
  const orders: BillOrderRow[] = []
  const calls = { query: 0, purchase: 0, debit: 0, insert: 0, alerts: [] as string[], purchaseInputs: [] as any[] }
  const cfg = allOn()
  const hub = { enabled: true, paused: false, services: Object.fromEntries(BILLER_KEYS.map(k => ["bill_" + k, true])) as Record<string, boolean> }
  let queryResult: any = { ok: true, data: [{ Display: "Name", Value: "Kofi", Amount: 0 }, { Display: "Amount Due", Value: "42.5", Amount: 0 }] }
  let wallet: "ok" | "insufficient" = "ok"
  const d: BillsDeps = {
    getBillsConfig: async () => cfg,
    getHubtelConfig: async () => hub,
    query: async () => { calls.query++; return queryResult },
    purchase: async (i) => { calls.purchase++; calls.purchaseInputs.push(i); return { client_reference: "CR1", state: "pending" } as HubtelCsTx },
    insertOrder: async (r) => {
      calls.insert++
      const o = { ...r, id: "o" + (orders.length + 1), hubtel_client_reference: null, commission: null, failure_reason: null, notes: null, created_at: "", updated_at: "" } as BillOrderRow
      orders.push(o)
      return { ...o }
    },
    updateOrder: async (id, patch, only) => {
      const o = orders.find(x => x.id === id)!
      if (only && !only.includes(o.status)) return 0
      Object.assign(o, patch)
      return 1
    },
    debitWallet: async () => { calls.debit++; return wallet },
    alert: async (m) => { calls.alerts.push(m) },
    newReference: () => "BILL-ABC",
    secret: "s".repeat(40),
    now: () => 1_000_000,
    ...over,
  }
  return {
    d, orders, calls,
    setCfg: (f: (c: BillsConfig) => void) => f(cfg),
    setHub: (f: (h: typeof hub) => void) => f(hub),
    setQuery: (q: any) => { queryResult = q },
    setWallet: (w: "ok" | "insufficient") => { wallet = w },
  }
}
const token = async (m: ReturnType<typeof make>, biller = "dstv", inputs: any = { account: "1234567890" }) => {
  const r = await verifyBill(m.d, "u1", biller, inputs)
  if (!r.ok || !r.token) throw new Error("no token " + JSON.stringify(r))
  return r.token
}

describe("verifyBill", () => {
  it("1 DSTV returns name, suggested amount, usable token", async () => {
    const m = make()
    const r = await verifyBill(m.d, "u1", "dstv", { account: "1234567890" })
    expect(r).toMatchObject({ ok: true, customerName: "Kofi", amountDue: 42.5, suggestedAmount: 42.5 })
    const p = await payBill(m.d, "u1", (r as any).token, 50)
    expect(p.ok).toBe(true)
  })
  it("2 bills disabled => 403, no query", async () => {
    const m = make(); m.setCfg(c => { c.enabled = false })
    const r = await verifyBill(m.d, "u1", "dstv", { account: "1234567890" })
    expect(r).toMatchObject({ ok: false, status: 403 })
    expect(m.calls.query).toBe(0)
  })
  it("3 ECG meters / addMeter rules", async () => {
    const m = make()
    m.setQuery({ ok: true, data: [{ Display: "Ama (Prepaid)", Value: "M111", Amount: 3 }, { Display: "Yaw", Value: "M222", Amount: 0 }] })
    const r = await verifyBill(m.d, "u1", "ecg", { phone: "0244000000" })
    expect(r.ok && r.meters!.length).toBe(2)
    expect(r.ok && r.meters!.every(x => !!x.token)).toBe(true)
    expect(await verifyBill(m.d, "u1", "ecg", { phone: "0244000000", account: "M999", addMeter: true })).toMatchObject({ ok: false, status: 400 })
    const u = await verifyBill(m.d, "u1", "ecg", { phone: "0244000000", account: "M999", addMeter: true, consent: true })
    expect(u.ok).toBe(true)
    const pay = await payBill(m.d, "u1", (u as any).token, 10)
    expect(pay.ok && pay.order.verified).toBe(false)
    const k = await verifyBill(m.d, "u1", "ecg", { phone: "0244000000", account: "M111", addMeter: true, consent: true })
    expect(k.ok && k.customerName).toBe("Ama")
    const pay2 = await payBill(m.d, "u1", (k as any).token, 10)
    expect(pay2.ok && pay2.order.verified).toBe(true)
  })
  it("4 Ghana Water without sessionId => 422", async () => {
    const m = make()
    const r = await verifyBill(m.d, "u1", "ghana_water", { phone: "0244000000", account: "GW12345", email: "a@b.com" })
    expect(r).toMatchObject({ ok: false, status: 422 })
  })
})

describe("payBill", () => {
  it("5 bad tokens => 400, nothing written", async () => {
    const m = make(); const t = await token(m)
    for (const bad of [t + "x", "A" + t.slice(1), "garbage"]) {
      expect(await payBill(m.d, "u1", bad, 10)).toMatchObject({ ok: false, status: 400 })
    }
    expect(await payBill(m.d, "u2", t, 10)).toMatchObject({ ok: false, status: 400 })
    const late = { ...m.d, now: () => 1_000_000 + 11 * 60_000 }
    expect(await payBill(late, "u1", t, 10)).toMatchObject({ ok: false, status: 400 })
    expect(m.calls.insert + m.calls.debit + m.calls.purchase).toBe(0)
  })
  it("6 paused / service off / biller off / config throws => no write", async () => {
    const m = make(); const t = await token(m)
    m.setHub(h => { h.paused = true })
    expect(await payBill(m.d, "u1", t, 10)).toMatchObject({ ok: false, status: 503 })
    m.setHub(h => { h.paused = false; h.services.bill_dstv = false })
    expect(await payBill(m.d, "u1", t, 10)).toMatchObject({ ok: false, status: 503 })
    m.setHub(h => { h.services.bill_dstv = true })
    m.setCfg(c => { c.billers.dstv.enabled = false })
    expect(await payBill(m.d, "u1", t, 10)).toMatchObject({ ok: false, status: 403 })
    m.setCfg(c => { c.billers.dstv.enabled = true })
    const boom = { ...m.d, getHubtelConfig: async () => { throw new Error("db") } }
    expect(await payBill(boom, "u1", t, 10)).toMatchObject({ ok: false, status: 503 })
    expect(m.calls.insert + m.calls.debit + m.calls.purchase).toBe(0)
  })
  it("7 amount limits / decimals => 400", async () => {
    const m = make(); const t = await token(m)
    for (const a of [1, 5000, 10.123, NaN]) expect(await payBill(m.d, "u1", t, a)).toMatchObject({ ok: false, status: 400 })
    expect(m.calls.insert + m.calls.debit).toBe(0)
  })
  it("8 insufficient => 402, failed, no purchase", async () => {
    const m = make(); m.setWallet("insufficient"); const t = await token(m)
    const r = await payBill(m.d, "u1", t, 10)
    expect(r).toMatchObject({ ok: false, status: 402 })
    expect(m.orders[0]).toMatchObject({ status: "failed", failure_reason: "Insufficient wallet balance" })
    expect(m.calls.purchase).toBe(0)
  })
  it("9 happy path, Ghana Water extras", async () => {
    const m = make()
    m.setQuery({ ok: true, data: [{ Display: "Name", Value: "Kofi" }, { Display: "Session ID", Value: "SESS1" }, { Display: "Amount Due", Value: "20" }] })
    const t = await token(m, "ghana_water", { phone: "0244000000", account: "GW12345", email: "a@b.com" })
    const r = await payBill(m.d, "u1", t, 20)
    expect(r.ok && r.order).toMatchObject({ status: "processing", payment_status: "paid", hubtel_client_reference: "CR1" })
    expect(m.calls.purchase).toBe(1)
    expect(m.calls.purchaseInputs[0]).toMatchObject({
      serviceKey: "bill_ghana_water", destination: "233244000000", bundle: "GW12345", amount: 20,
      orderTable: "hubtel_bill_orders", orderId: "o1", extra: { email: "a@b.com", sessionId: "SESS1" },
    })
    expect(m.calls.insert).toBe(1)
    expect(m.calls.debit).toBe(1)
  })
  it("10 autoFulfil off => pending+paid, no purchase", async () => {
    const m = make(); m.setCfg(c => { c.autoFulfil = false }); const t = await token(m)
    const r = await payBill(m.d, "u1", t, 10)
    expect(r.ok && r.order).toMatchObject({ status: "pending", payment_status: "paid" })
    expect(m.calls.purchase).toBe(0)
  })
  it("11 purchase throws Paused => stays pending paid, note, alert", async () => {
    const m = make()
    let n = 0
    const d = { ...m.d, purchase: async () => { n++; throw new HubtelPausedError(null) } }
    const t = await token(m)
    const r = await payBill(d, "u1", t, 10)
    expect(r.ok && r.order).toMatchObject({ status: "pending", payment_status: "paid" })
    expect(m.orders[0].notes).toMatch(/Not sent/)
    expect(m.calls.alerts.length).toBe(1)
    expect(n).toBe(1)
  })
  it("12 outcome unknown => processing + alert; redispatch no-op", async () => {
    let n = 0
    const m = make()
    const d = { ...m.d, purchase: async () => { n++; throw new HubtelOutcomeUnknownError("CRX", new Error("x")) } }
    const t = await token(m)
    await payBill(d, "u1", t, 10)
    expect(m.orders[0].status).toBe("processing")
    expect(m.orders[0].notes).toMatch(/CRX/)
    expect(m.calls.alerts.length).toBe(1)
    expect(await dispatchBillOrder(d, m.orders[0])).toBe("processing")
    expect(n).toBe(1)
  })
})
