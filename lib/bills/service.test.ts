import { describe, it, expect } from "vitest"
import { verifyBill, payBill, dispatchBillOrder, type BillsDeps, type BillOrderRow } from "./service"
import { resolveBillsConfig, type BillsConfig } from "./config"
import { BILLER_KEYS } from "./billers"
import { HubtelPausedError, HubtelOutcomeUnknownError, HubtelDuplicateOrderError } from "@/lib/hubtel-cs/errors"
import type { HubtelCsTx } from "@/lib/hubtel-cs/types"
import { resolveCashbackConfig, type CashbackConfig } from "@/lib/cashback/config"

const allOn = (): BillsConfig =>
  resolveBillsConfig({ enabled: true, billers: Object.fromEntries(BILLER_KEYS.map(k => [k, { enabled: true, min: 5, max: 1000 }])) })

function make(over: Partial<BillsDeps> = {}) {
  const orders: BillOrderRow[] = []
  const calls = { query: 0, purchase: 0, debit: 0, insert: 0, alerts: [] as string[], purchaseInputs: [] as any[], debitAmounts: [] as number[] }
  const cfg = allOn()
  let cashback: CashbackConfig = resolveCashbackConfig({}) // off by default: every legacy test runs unchanged
  let tier: "customer" | "dealer" = "customer"
  const hub = { enabled: true, paused: false, services: Object.fromEntries(BILLER_KEYS.map(k => ["bill_" + k, true])) as Record<string, boolean> }
  let queryResult: any = { ok: true, data: [{ Display: "Name", Value: "Kofi", Amount: 0 }, { Display: "Amount Due", Value: "42.5", Amount: 0 }] }
  let wallet: "ok" | "insufficient" | "not_found" | "throw_paid" | "throw_unpaid" = "ok"
  const hashes = new Set<string>()
  const d: BillsDeps = {
    getCashbackConfig: async () => cashback,
    getBuyerTier: async () => tier,
    getBillsConfig: async () => cfg,
    getHubtelConfig: async () => hub,
    query: async () => { calls.query++; return queryResult },
    purchase: async (i) => { calls.purchase++; calls.purchaseInputs.push(i); return { client_reference: "CR1", state: "pending" } as HubtelCsTx },
    insertOrder: async (r) => {
      calls.insert++
      if ((r as any).verify_token_hash) {
        if (hashes.has((r as any).verify_token_hash)) throw Object.assign(new Error("duplicate key"), { code: "23505" })
        hashes.add((r as any).verify_token_hash)
      }
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
    getOrder: async (id) => { const o = orders.find(x => x.id === id); return o ? { ...o } : null },
    debitOrder: async (id) => {
      calls.debit++
      const o = orders.find(x => x.id === id)!
      // Mirrors bill_order_debit (0119): deducts COALESCE(paid_amount, amount).
      if (wallet === "ok" || wallet === "throw_paid") { o.payment_status = "paid"; calls.debitAmounts.push(o.paid_amount ?? o.amount) }
      if (wallet === "throw_paid" || wallet === "throw_unpaid") throw new Error("rpc down")
      return wallet
    },
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
    setWallet: (w: "ok" | "insufficient" | "not_found" | "throw_paid" | "throw_unpaid") => { wallet = w },
    setCashback: (c: CashbackConfig) => { cashback = c },
    setTier: (t: "customer" | "dealer") => { tier = t },
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
    expect(m.orders[0]).toMatchObject({ status: "failed", payment_status: "unpaid", failure_reason: "Insufficient wallet balance" })
    expect(m.calls.purchase).toBe(0)
    expect(m.calls.debit).toBe(1)
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

describe("dispatch claim", () => {
  it("claims pending -> processing BEFORE purchase", async () => {
    const m = make(); m.setCfg(c => { c.autoFulfil = false }); const t = await token(m)
    await payBill(m.d, "u1", t, 10)
    let seen = ""
    const d = { ...m.d, purchase: async (i: any) => { seen = m.orders[0].status + "/" + m.orders[0].notes; return { client_reference: "CR9", state: "pending" } as HubtelCsTx } }
    expect(await dispatchBillOrder(d, m.orders[0])).toBe("processing")
    expect(seen).toBe("processing/Dispatching…")
    expect(m.orders[0]).toMatchObject({ status: "processing", hubtel_client_reference: "CR9", notes: null })
  })
  it("a second concurrent dispatch loses the claim and never calls purchase", async () => {
    const m = make(); m.setCfg(c => { c.autoFulfil = false }); const t = await token(m)
    await payBill(m.d, "u1", t, 10)
    const snap = { ...m.orders[0] }
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let n = 0
    const d = { ...m.d, purchase: async () => { n++; await gate; return { client_reference: "CR1", state: "pending" } as HubtelCsTx } }
    const first = dispatchBillOrder(d, snap)
    await new Promise(r => setTimeout(r, 0))
    // Second caller holds a stale pending snapshot and a getOrder that still reports pending: only the claim stops it.
    const d2 = { ...d, getOrder: async () => ({ ...snap }) }
    expect(await dispatchBillOrder(d2, snap)).toBe("pending")
    expect(n).toBe(1)
    release()
    expect(await first).toBe("processing")
  })
  it("Not-sent error releases the claim back to pending with the reason", async () => {
    const m = make(); m.setCfg(c => { c.autoFulfil = false }); const t = await token(m)
    await payBill(m.d, "u1", t, 10)
    const d = { ...m.d, purchase: async () => { throw new HubtelPausedError(null) } }
    expect(await dispatchBillOrder(d, m.orders[0])).toBe("pending")
    expect(m.orders[0]).toMatchObject({ status: "pending" })
    expect(m.orders[0].notes).toMatch(/^Not sent/)
    expect(m.calls.alerts.length).toBe(1)
  })
})

describe("review fixes", () => {
  it("debitOrder throws but DB says paid => continues as paid and dispatches", async () => {
    const m = make(); m.setWallet("throw_paid"); const t = await token(m)
    const r = await payBill(m.d, "u1", t, 10)
    expect(r.ok && r.order).toMatchObject({ payment_status: "paid", status: "processing" })
    expect(m.calls.purchase).toBe(1)
  })
  it("debitOrder throws and DB unpaid => alert + 500, no purchase, order left pending unpaid", async () => {
    const m = make(); m.setWallet("throw_unpaid"); const t = await token(m)
    const r = await payBill(m.d, "u1", t, 10)
    expect(r).toMatchObject({ ok: false, status: 500 })
    expect(m.orders[0]).toMatchObject({ status: "pending", payment_status: "unpaid" })
    expect(m.calls.alerts.join()).toMatch(/debit outcome uncertain/)
    expect(m.calls.purchase).toBe(0)
  })
  it("not_found => 409", async () => {
    const m = make(); m.setWallet("not_found"); const t = await token(m)
    expect(await payBill(m.d, "u1", t, 10)).toMatchObject({ ok: false, status: 409 })
    expect(m.calls.purchase).toBe(0)
  })
  it("token reuse => 409, nothing debited the second time", async () => {
    const m = make(); const t = await token(m)
    expect((await payBill(m.d, "u1", t, 10)).ok).toBe(true)
    const r = await payBill(m.d, "u1", t, 10)
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(m.calls.debit).toBe(1)
    expect(m.calls.purchase).toBe(1)
  })
  it("Not-sent note is guarded; no alert when 0 rows matched", async () => {
    const m = make()
    const d: BillsDeps = {
      ...m.d,
      purchase: async () => { throw new HubtelPausedError(null) },
      updateOrder: async (id, patch, only) => { if ((patch as any).notes && only?.includes("processing") && (patch as any).status === "pending") { m.orders[0].status = "failed"; return 0 } return m.d.updateOrder(id, patch, only) },
    }
    const t = await token(m)
    await payBill(d, "u1", t, 10)
    expect(m.calls.alerts.length).toBe(0)
  })
  it("duplicate order error alerts and does not write", async () => {
    const m = make()
    const d = { ...m.d, purchase: async () => { throw new HubtelDuplicateOrderError("hubtel_bill_orders", "o1") } }
    const t = await token(m)
    const r = await payBill(d, "u1", t, 10)
    expect(r.ok && r.order.status).toBe("processing")
    expect(m.orders[0].notes).toMatch(/do not resend/)
    expect(m.calls.alerts.join()).toMatch(/do not resend/)
  })
  it("stale snapshot (fresh row failed) => no purchase", async () => {
    const m = make(); const t = await token(m)
    await payBill({ ...m.d, purchase: async () => { throw new HubtelPausedError(null) } }, "u1", t, 10)
    const stale = { ...m.orders[0] }
    m.orders[0].status = "failed"
    expect(await dispatchBillOrder(m.d, stale)).toBe("failed")
    expect(m.calls.purchase).toBe(0)
  })
  it("empty secret => 503 on verify and pay", async () => {
    const m = make(); const d = { ...m.d, secret: "" }
    expect(await verifyBill(d, "u1", "dstv", { account: "1234567890" })).toMatchObject({ ok: false, status: 503 })
    expect(await payBill(d, "u1", "x.y", 10)).toMatchObject({ ok: false, status: 503 })
    expect(m.calls.query + m.calls.insert).toBe(0)
  })
  it("getBillsConfig throws / hubtel disabled => 503, nothing written", async () => {
    const m = make(); const t = await token(m)
    expect(await payBill({ ...m.d, getBillsConfig: async () => { throw new Error("x") } }, "u1", t, 10)).toMatchObject({ ok: false, status: 503 })
    m.setHub(h => { h.enabled = false })
    expect(await payBill(m.d, "u1", t, 10)).toMatchObject({ ok: false, status: 503 })
    expect(m.calls.insert + m.calls.debit).toBe(0)
  })
  it("query throw => generic 422; addMeter without account => 400 meter message", async () => {
    const m = make()
    const r = await verifyBill({ ...m.d, query: async () => { throw new Error("secret detail") } }, "u1", "dstv", { account: "1234567890" })
    expect(r).toMatchObject({ ok: false, status: 422, error: "Couldn't verify this account right now" })
    expect(await verifyBill(m.d, "u1", "ecg", { phone: "0244000000", addMeter: true })).toMatchObject({ ok: false, status: 400, error: "Enter the meter or account number" })
  })
})

describe("final review fixes", () => {
  const setup = async (over: Partial<BillsDeps> = {}) => {
    const m = make(over)
    m.setCfg(c => { c.autoFulfil = false })
    return m
  }
  it("uncertain debit alert is urgent", async () => {
    const flags: any[] = []
    const m = make({ alert: async (_msg, u) => { flags.push(u) } })
    m.setWallet("throw_unpaid")
    const v = await verifyBill(m.d, "u1", "dstv", { account: "ABCD1234" } as any)
    await payBill(m.d, "u1", (v as any).token, 10)
    expect(flags).toContain(true)
  })
  it("getOrder throwing in dispatch alerts", async () => {
    const m = await setup()
    const v = await verifyBill(m.d, "u1", "dstv", { account: "ABCD1234" } as any)
    const r = await payBill(m.d, "u1", (v as any).token, 10)
    m.calls.alerts.length = 0
    await dispatchBillOrder({ ...m.d, getOrder: async () => { throw new Error("db") } }, (r as any).order)
    expect(m.calls.alerts.length).toBe(1)
    expect(m.calls.purchase).toBe(0)
  })
  it("0-row processing write: returns the real status, no alert when a callback settled it", async () => {
    const m = make()
    const v = await verifyBill(m.d, "u1", "dstv", { account: "ABCD1234" } as any)
    const d2: BillsDeps = {
      ...m.d,
      purchase: async () => { m.orders[0].status = "completed"; return { client_reference: "CR1", state: "pending" } as HubtelCsTx },
    }
    const r = await payBill(d2, "u1", (v as any).token, 10)
    expect((r as any).order.status).toBe("completed")
    expect(m.calls.alerts).toEqual([])
  })
  it("0-row processing write alerts when still processing without a ref", async () => {
    const m = make()
    const v = await verifyBill(m.d, "u1", "dstv", { account: "ABCD1234" } as any)
    const d2: BillsDeps = { ...m.d, updateOrder: async (id, p, only) => (p.hubtel_client_reference ? 0 : m.d.updateOrder(id, p, only)) }
    const r = await payBill(d2, "u1", (v as any).token, 10)
    expect((r as any).order.status).toBe("processing")
    expect(m.calls.alerts.some(a => a.includes("could not be updated"))).toBe(true)
  })
})

describe("payBill — instant cashback", () => {
  // bill_dstv at 2% commission; bills customer share 50%, dealer 75%. GHS 100 => commission 2.00.
  const CB = (over: Record<string, unknown> = {}) => resolveCashbackConfig({
    enabled: true,
    surfaces: { dashboard: true },
    rates: { "bill_dstv:hubtel": 2 },
    shares: { bills: { customer: 50, dealer: 75, storefrontCustomer: 0, storefrontShop: 0 } },
    ...over,
  })

  it("applied (customer): wallet debited 99, order amount 100 (face), Hubtel receives 100, snapshot columns set", async () => {
    const m = make(); m.setCashback(CB()); const t = await token(m)
    const r = await payBill(m.d, "u1", t, 100)
    expect(r.ok).toBe(true)
    expect(m.calls.debitAmounts).toEqual([99])
    expect(m.calls.purchaseInputs[0]).toMatchObject({ serviceKey: "bill_dstv", amount: 100 })
    expect(m.orders[0]).toMatchObject({
      amount: 100, paid_amount: 99, cashback_amount: 1, shop_share_amount: 0, cashback_rate: 2, cashback_share: 50,
      cashback_provider: "hubtel", expected_commission: 2,
    })
    expect(r.ok && r.order).toMatchObject({ amount: 100, paid_amount: 99, cashback_amount: 1 })
  })
  it("applied (dealer tier): debits 98.5", async () => {
    const m = make(); m.setCashback(CB()); m.setTier("dealer"); const t = await token(m)
    await payBill(m.d, "u1", t, 100)
    expect(m.calls.debitAmounts).toEqual([98.5])
    expect(m.orders[0]).toMatchObject({ amount: 100, paid_amount: 98.5, cashback_amount: 1.5, cashback_share: 75 })
  })
  it("expectedPay matching the quote proceeds", async () => {
    const m = make(); m.setCashback(CB()); const t = await token(m)
    expect((await payBill(m.d, "u1", t, 100, 99)).ok).toBe(true)
    expect(m.calls.debitAmounts).toEqual([99])
  })
  it("expectedPay mismatch => 409 'Price updated' with the quote, nothing written", async () => {
    const m = make(); m.setCashback(CB()); const t = await token(m)
    expect(await payBill(m.d, "u1", t, 100, 100)).toEqual({
      ok: false, status: 409, error: "Price updated — please review",
      quote: { faceAmount: 100, payAmount: 99, customerCashback: 1 },
    })
    expect(m.calls.insert + m.calls.debit + m.calls.purchase).toBe(0)
    // The token was not consumed: paying at the quoted price still works.
    expect((await payBill(m.d, "u1", t, 100, 99)).ok).toBe(true)
  })
  it("expectedPay mismatch while not applied (shown a cashback price, cashback since switched off) => 409 at face", async () => {
    const m = make(); const t = await token(m)
    expect(await payBill(m.d, "u1", t, 100, 99)).toMatchObject({
      ok: false, status: 409, quote: { faceAmount: 100, payAmount: 100, customerCashback: 0 },
    })
    expect(m.calls.insert).toBe(0)
  })
  it("cashback runs after the pre-checks: amount out of range / paused still fail first, nothing written", async () => {
    const m = make(); m.setCashback(CB()); const t = await token(m)
    expect(await payBill(m.d, "u1", t, 5000, 1)).toMatchObject({ ok: false, status: 400 })
    m.setHub(h => { h.paused = true })
    expect(await payBill(m.d, "u1", t, 100, 1)).toMatchObject({ ok: false, status: 503 })
    expect(m.calls.insert).toBe(0)
  })
  it("not applied (master off / dashboard off / no rate) => paid_amount null, no snapshot, debit = amount", async () => {
    for (const cfg of [CB({ enabled: false }), CB({ surfaces: { dashboard: false, bots: true } }), CB({ rates: {} })]) {
      const m = make(); m.setCashback(cfg); const t = await token(m)
      expect((await payBill(m.d, "u1", t, 100)).ok).toBe(true)
      expect(m.orders[0].paid_amount).toBeNull()
      expect(m.orders[0]).not.toHaveProperty("cashback_amount")
      expect(m.calls.debitAmounts).toEqual([100])
      expect(m.calls.purchaseInputs[0].amount).toBe(100)
    }
  })
  it("config or tier read failure => not applied, purchase goes ahead at face", async () => {
    for (const over of [
      { getCashbackConfig: async () => { throw new Error("db") } },
      { getBuyerTier: async () => { throw new Error("db") } },
    ] as Partial<BillsDeps>[]) {
      const m = make(over); m.setCashback(CB()); const t = await token(m)
      expect((await payBill(m.d, "u1", t, 100)).ok).toBe(true)
      expect(m.orders[0].paid_amount).toBeNull()
      expect(m.calls.debitAmounts).toEqual([100])
    }
  })
  it("biller without a configured rate is not applied (other biller keys unaffected)", async () => {
    const m = make(); m.setCashback(CB())
    const t = await token(m, "gotv")
    await payBill(m.d, "u1", t, 100)
    expect(m.orders[0].paid_amount).toBeNull()
    expect(m.calls.debitAmounts).toEqual([100])
  })
})
