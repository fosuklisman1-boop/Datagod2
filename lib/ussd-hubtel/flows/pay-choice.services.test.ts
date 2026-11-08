// lib/ussd-hubtel/flows/pay-choice.services.test.ts
// Wallet or MoMo choice on the Hubtel main code for Airtime, Buy Vouchers and Check Results. Drives the real router.
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeAirtime, fakeRc, fakeSupabase, makeDeps, NEW_ID, req } from "../testing/fakes"
import type { HubtelUssdConfig } from "../config"
import type { HubtelReply } from "../types"
import type { StorefrontQuote } from "@/lib/cashback/quote"
import { USSD_SCREEN_LIMIT } from "../protocol"

const UNAVAILABLE = "Service unavailable. Please try again later."

const config = (over: Partial<HubtelUssdConfig> = {}): HubtelUssdConfig => ({
  welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "main",
  visibility: { data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: true },
  walletPayment: true, ...over,
})

interface PayRow { id: string; session_id: string; order_table: string; order_id: string; user_id: string; amount: number; state: string; updated_at: string; created_at: string }

/** A fake world: fakeSupabase plus the wallet RPC and the hubtel_wallet_payments table. */
function world(o: {
  balance?: number
  cfg?: Partial<HubtelUssdConfig>
  handlers?: Record<string, (id: string) => Promise<void>>
  dialer?: RouterDeps["resolveDialer"]
  over?: Partial<RouterDeps>
} = {}) {
  const sup = fakeSupabase()
  const payments: PayRow[] = []
  const rpcCalls: any[] = []
  const baseFrom = sup.client.from.bind(sup.client)
  sup.client.from = (table: string) => {
    if (table !== "hubtel_wallet_payments") return baseFrom(table)
    const filters: Record<string, unknown> = {}
    let patch: any = null
    const match = () => payments.filter(p => Object.entries(filters).every(([k, v]) => (p as any)[k] === v))
    const b: any = {
      select() { return b },
      eq(c: string, v: unknown) { filters[c] = v; return b },
      update(p: any) { patch = p; return b },
      maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
      then(res: any) {
        if (patch) {
          const rows = match()
          for (const r of rows) Object.assign(r, patch)
          return res({ data: rows.map(r => ({ id: r.id, amount: r.amount })), error: null })
        }
        return res({ data: match(), error: null })
      },
    }
    return b
  }
  sup.client.rpc = vi.fn(async (name: string, args: any) => {
    rpcCalls.push({ name, args })
    const id = `pay-${payments.length + 1}`
    payments.push({ id, session_id: args.p_session, order_table: args.p_table, order_id: args.p_order, user_id: args.p_user, amount: args.p_amount, state: "debited", created_at: "", updated_at: "" })
    return { data: { payment_id: id, replay: false, new_balance: 0 }, error: null }
  })
  const handler = vi.fn(async (_id: string) => undefined)
  const alert = vi.fn(async (_m: string) => undefined)
  const deferred: Array<() => Promise<unknown>> = []
  const resolveDialer = vi.fn(o.dialer ?? (async () => ({ userId: "user-1", balance: o.balance ?? 100 })))
  const { deps, store } = makeDeps({
    getConfig: async () => config(o.cfg),
    resolveDialer,
    isPhoneVerified: async () => true,
    walletPayDeps: () => ({
      db: sup.client,
      handlers: o.handlers ?? { airtime_orders: handler, results_checker_orders: handler, results_check_requests: handler },
      alert,
    }),
    defer: (t: () => Promise<unknown>) => { deferred.push(t) },
    ...(o.over ?? {}),
  }, sup)
  const runDeferred = async () => { while (deferred.length) await deferred.shift()!() }
  return { deps, store, sup, payments, rpcCalls, handler, alert, deferred, runDeferred, resolveDialer }
}
const press = (deps: RouterDeps, m: string) => hubtelRouter(req({ Message: m }), deps)
async function send(deps: RouterDeps, inputs: string[]): Promise<HubtelReply> {
  let r!: HubtelReply
  for (const m of inputs) r = await press(deps, m)
  return r
}
async function start(deps: RouterDeps, label: string) {
  const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
  return press(deps, digitFor(menu.Message, label))
}
const choice = (bal: number) => `Pay with:\n1. Datagod Wallet\n   (bal GHS ${bal.toFixed(2)})\n2. MoMo\n0. Cancel`

// ---------------------------------------------------------------- airtime

const walkAirtime = async (deps: RouterDeps) => {
  await start(deps, "Buy Airtime")
  return send(deps, ["0244123456", "10"]) // MTN, GHS 10 -> confirm
}
const cbQuote = (pay: number, face = 10): StorefrontQuote => ({
  applied: true, faceAmount: face, payAmount: pay, paymentFee: 0.1, customerCashback: 0.4, shopShare: 0,
  rate: 4, share: 100, provider: "hubtel", commission: 0.5,
} as unknown as StorefrontQuote)

describe("pay choice: airtime, fee-priced", () => {
  it("the choice screen shows at the typed amount, with no order created", async () => {
    const w = world({ balance: 42 })
    expect((await walkAirtime(w.deps)).Message).toContain("You pay GHS 10.00")
    const r = await press(w.deps, "1")
    expect(r.Message).toBe(choice(42))
    expect(w.store.get("S1")).toMatchObject({ step: "PAY_CHOICE", payKind: "airtime" })
    expect(w.sup.inserts["airtime_orders"]).toBeUndefined()
    expect(w.rpcCalls).toHaveLength(0)
  })
  it("1 debits the amount from the wallet, with the airtime source and Uzo's final text", async () => {
    const w = world()
    await walkAirtime(w.deps)
    await press(w.deps, "1")
    const r = await press(w.deps, "1")
    expect(r.Type).toBe("release")
    expect(r.Message).toBe("Payment successful.\nAirtime will reflect\nshortly.")
    expect(w.sup.inserts["airtime_orders"][0]).toMatchObject({ total_paid: 10, airtime_amount: 9.52, status: "pending_payment" })
    expect(w.sup.inserts["hubtel_transactions"]).toBeUndefined()
    expect(w.rpcCalls[0]).toMatchObject({
      name: "pay_hubtel_order_from_wallet",
      args: { p_session: "S1", p_user: "user-1", p_table: "airtime_orders", p_order: NEW_ID, p_amount: 10, p_source: "airtime_purchase" },
    })
    expect(w.rpcCalls[0].args.p_description).not.toContain("0244123456")
    expect(w.rpcCalls[0].args.p_description).toBe("Airtime: MTN GHS 9.52")
    await w.runDeferred()
    expect(w.handler).toHaveBeenCalledWith(NEW_ID)
  })
  it("a whole airtime amount shows two decimals in the history text", async () => {
    const w = world({ over: { airtime: fakeAirtime({ cashbackQuote: async () => cbQuote(9.6) }) } })
    await walkAirtime(w.deps)
    await press(w.deps, "1")
    await press(w.deps, "1")
    expect(w.rpcCalls[0].args.p_description).toBe("Airtime: MTN GHS 10.00")
  })
  it("2 gives today's AddToCart at the same price", async () => {
    const w = world()
    await walkAirtime(w.deps)
    await press(w.deps, "1")
    const r = await press(w.deps, "2")
    expect(r.Type).toBe("AddToCart")
    expect(r.Item?.Price).toBe(10)
    expect(w.rpcCalls).toHaveLength(0)
    expect(w.sup.inserts["hubtel_transactions"]).toHaveLength(1)
  })
  it("switch off: AddToCart exactly as before, no balance read", async () => {
    const w = world({ cfg: { walletPayment: false } })
    await walkAirtime(w.deps)
    const before = w.resolveDialer.mock.calls.length
    const r = await press(w.deps, "1")
    expect(r.Type).toBe("AddToCart")
    expect(w.resolveDialer.mock.calls.length - before).toBe(1) // the confirm's own read, as today; no balance read
    expect(w.rpcCalls).toHaveLength(0)
  })
  it("balance short: AddToCart", async () => {
    const w = world({ balance: 9.99 })
    await walkAirtime(w.deps)
    expect((await press(w.deps, "1")).Type).toBe("AddToCart")
  })
  for (const m of ["1", "2"]) {
    it(`rates changed on the screen: ${m} gives the existing message, nothing charged`, async () => {
      let rate = 5
      const w = world({ over: { airtime: fakeAirtime({ feeRate: async () => rate }) } })
      await walkAirtime(w.deps)
      await press(w.deps, "1")
      rate = 8
      const r = await press(w.deps, m)
      expect(r.Message).toBe("Airtime rates changed. Please restart your order.")
      expect(w.sup.inserts["airtime_orders"]).toBeUndefined()
      expect(w.rpcCalls).toHaveLength(0)
    })
    it(`network switched off on the screen: ${m} gives the existing message`, async () => {
      let on = true
      const w = world({ over: { airtime: fakeAirtime({ isEnabled: async () => on }) } })
      await walkAirtime(w.deps)
      await press(w.deps, "1")
      on = false
      expect((await press(w.deps, m)).Message).toBe("MTN airtime is no longer available.")
      expect(w.rpcCalls).toHaveLength(0)
    })
  }
})

describe("pay choice: airtime, cashback-priced", () => {
  const walk = async (deps: RouterDeps) => {
    await start(deps, "Buy Airtime")
    return send(deps, ["0244123456", "10"])
  }
  it("the choice screen and the debit use cb.payAmount, and the row records it", async () => {
    const w = world({ balance: 42, over: { airtime: fakeAirtime({ cashbackQuote: async () => cbQuote(9.6) }) } })
    expect((await walk(w.deps)).Message).toContain("Pay GHS 9.60")
    expect((await press(w.deps, "1")).Message).toBe(choice(42))
    const r = await press(w.deps, "1")
    expect(r.Message).toBe("Payment successful.\nAirtime will reflect\nshortly.")
    expect(w.rpcCalls[0].args).toMatchObject({ p_table: "airtime_orders", p_amount: 9.6, p_source: "airtime_purchase" })
    expect(w.sup.inserts["airtime_orders"][0]).toMatchObject({ total_paid: 9.6, airtime_amount: 10 })
  })
  it("2 carts at cb.payAmount", async () => {
    const w = world({ over: { airtime: fakeAirtime({ cashbackQuote: async () => cbQuote(9.6) }) } })
    await walk(w.deps)
    await press(w.deps, "1")
    const r = await press(w.deps, "2")
    expect(r.Type).toBe("AddToCart")
    expect(r.Item?.Price).toBe(9.6)
  })
  for (const m of ["1", "2"]) {
    it(`cashback re-rated on the screen: ${m} gives the existing message, nothing charged`, async () => {
      let pay = 9.6
      const w = world({ over: { airtime: fakeAirtime({ cashbackQuote: async () => cbQuote(pay) }) } })
      await walk(w.deps)
      await press(w.deps, "1")
      pay = 9.7
      expect((await press(w.deps, m)).Message).toBe("Airtime rates changed. Please restart your order.")
      expect(w.sup.inserts["airtime_orders"]).toBeUndefined()
      expect(w.rpcCalls).toHaveLength(0)
    })
  }
})

// ---------------------------------------------------------------- buy vouchers

const walkRc = async (deps: RouterDeps) => {
  await start(deps, "Results Checker")
  return send(deps, ["1", "1", "2"]) // Buy Vouchers, WASSCE, quantity 2 -> confirm (GHS 40)
}

describe("pay choice: buy vouchers", () => {
  it("the choice screen shows at the confirm price", async () => {
    const w = world({ balance: 42 })
    expect((await walkRc(w.deps)).Message).toContain("GHS 40.00")
    expect((await press(w.deps, "1")).Message).toBe(choice(42))
    expect(w.store.get("S1")).toMatchObject({ step: "PAY_CHOICE", payKind: "rc" })
    expect(w.sup.inserts["results_checker_orders"]).toBeUndefined()
  })
  it("1 debits the total from the wallet and ends with Uzo's text naming the reference", async () => {
    const w = world()
    await walkRc(w.deps)
    await press(w.deps, "1")
    const r = await press(w.deps, "1")
    const row = w.sup.inserts["results_checker_orders"][0]
    expect(row).toMatchObject({ total_paid: 40, quantity: 2, exam_board: "WASSCE" })
    expect(r.Type).toBe("release")
    expect(r.Message).toBe(`Success! Ref ${row.reference_code}.\nYour WASSCE vouchers will be\nsent by SMS shortly.`)
    expect(r.Message.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
    // The longest board name and a two-digit quantity still fit one screen.
    const longest = `Success! Ref ${row.reference_code}.\nYour NOVDEC vouchers will be\nsent by SMS shortly.`
    expect(longest.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
    expect(w.rpcCalls[0].args).toMatchObject({ p_table: "results_checker_orders", p_amount: 40, p_source: "ussd_results_checker" })
    expect(w.rpcCalls[0].args.p_description).not.toMatch(/\d{9,}/)
    await w.runDeferred()
    expect(w.handler).toHaveBeenCalledWith(NEW_ID)
  })
  it("a single voucher says voucher, not vouchers", async () => {
    const w = world()
    await start(w.deps, "Results Checker")
    await send(w.deps, ["1", "1", "1"])
    await press(w.deps, "1")
    expect((await press(w.deps, "1")).Message).toMatch(/Your WASSCE voucher will be\nsent by SMS shortly\.$/)
  })
  it("2 gives today's AddToCart", async () => {
    const w = world()
    await walkRc(w.deps)
    await press(w.deps, "1")
    const r = await press(w.deps, "2")
    expect(r.Type).toBe("AddToCart")
    expect(r.Item?.Price).toBe(40)
    expect(w.rpcCalls).toHaveLength(0)
  })
  it("switch off: AddToCart", async () => {
    const w = world({ cfg: { walletPayment: false } })
    await walkRc(w.deps)
    expect((await press(w.deps, "1")).Type).toBe("AddToCart")
  })
  for (const m of ["1", "2"]) {
    it(`sold out while on the screen: ${m} gives the existing message, no order, no debit`, async () => {
      let available = 10
      const w = world({ over: { rc: fakeRc({ availableCount: async () => available }) } })
      await walkRc(w.deps)
      await press(w.deps, "1")
      available = 1
      expect((await press(w.deps, m)).Message).toBe("WASSCE vouchers are no longer available in that quantity. Please try again.")
      expect(w.sup.inserts["results_checker_orders"]).toBeUndefined()
      expect(w.rpcCalls).toHaveLength(0)
    })
    it(`price changed while on the screen: ${m} gives the existing message`, async () => {
      let unit = 20
      const w = world({ over: { rc: fakeRc({ price: async (_b, q) => ({ unitPrice: unit, totalPaid: unit * q, bulkApplied: false }) }) } })
      await walkRc(w.deps)
      await press(w.deps, "1")
      unit = 25
      expect((await press(w.deps, m)).Message).toBe("Price changed to GHS 50.00. Please restart your order.")
      expect(w.rpcCalls).toHaveLength(0)
    })
  }
  it("the buy flow's own cancel is still 2, and the wallet screen's cancel is 0", async () => {
    const w = world()
    await walkRc(w.deps)
    expect((await press(w.deps, "2")).Message).toBe("Order cancelled.")
    const w2 = world()
    await walkRc(w2.deps)
    await press(w2.deps, "1")
    expect((await press(w2.deps, "0")).Message).toBe("Order cancelled.")
    expect(w2.sup.inserts["results_checker_orders"]).toBeUndefined()
  })
})

// ---------------------------------------------------------------- check results

// WASSCE, School, combo, index, year, DOB, WhatsApp
const COMBO = ["1", "1", "1", "0070202043", "2024", "15/06/2008", "0244123456"]
// WASSCE, School, I have a voucher, PIN/serial, index, year, DOB, WhatsApp
const OWN = ["1", "1", "2", "012345678912/WGR1900112581", "0070202043", "2024", "15/06/2008", "0244123456"]
const walkCheck = async (deps: RouterDeps, inputs: string[]) => {
  await start(deps, "Results Checker")
  await press(deps, "3")
  return send(deps, inputs)
}
const CHECK_PAID = "Payment successful!\nWe'll check your\nWASSCE results and\nsend them to you shortly."

describe("pay choice: check results", () => {
  it("combo: the choice screen shows at the combo total", async () => {
    const w = world({ balance: 42 })
    expect((await walkCheck(w.deps, COMBO)).Message).toContain("GHS 22.00")
    expect((await press(w.deps, "1")).Message).toBe(choice(42))
    expect(w.store.get("S1")).toMatchObject({ step: "PAY_CHOICE", payKind: "rc_check" })
    expect(w.sup.inserts["results_check_requests"]).toBeUndefined()
  })
  it("1 debits the combo total, with the request source, and ends with Uzo's text", async () => {
    const w = world()
    await walkCheck(w.deps, COMBO)
    await press(w.deps, "1")
    const r = await press(w.deps, "1")
    expect(r.Type).toBe("release")
    expect(r.Message).toBe(CHECK_PAID)
    expect(w.sup.inserts["results_check_requests"][0]).toMatchObject({ fee: 22, mode: "combo", user_id: "user-1" })
    expect(w.rpcCalls[0].args).toMatchObject({ p_table: "results_check_requests", p_amount: 22, p_source: "results_check_request" })
    expect(w.rpcCalls[0].args.p_description).not.toContain("0244123456")
    await w.runDeferred()
    expect(w.handler).toHaveBeenCalledWith(NEW_ID)
  })
  it("own voucher: debits the check fee", async () => {
    const w = world()
    await walkCheck(w.deps, OWN)
    await press(w.deps, "1")
    await press(w.deps, "1")
    expect(w.rpcCalls[0].args).toMatchObject({ p_table: "results_check_requests", p_amount: 2 })
    expect(w.sup.inserts["results_check_requests"][0]).toMatchObject({ fee: 2, mode: "own_voucher" })
  })
  it("2 gives today's AddToCart", async () => {
    const w = world()
    await walkCheck(w.deps, COMBO)
    await press(w.deps, "1")
    const r = await press(w.deps, "2")
    expect(r.Type).toBe("AddToCart")
    expect(r.Item?.Price).toBe(22)
    expect(w.rpcCalls).toHaveLength(0)
  })
  it("switch off: AddToCart", async () => {
    const w = world({ cfg: { walletPayment: false } })
    await walkCheck(w.deps, COMBO)
    expect((await press(w.deps, "1")).Type).toBe("AddToCart")
  })
  it("the confirm's own cancel is 2; the wallet screen's cancel is 0", async () => {
    const w = world()
    await walkCheck(w.deps, COMBO)
    expect((await press(w.deps, "2")).Message).toBe("Order cancelled.")
    const w2 = world()
    await walkCheck(w2.deps, COMBO)
    await press(w2.deps, "1")
    expect((await press(w2.deps, "0")).Message).toBe("Order cancelled.")
    expect(w2.sup.inserts["results_check_requests"]).toBeUndefined()
  })
  for (const m of ["1", "2"]) {
    it(`combo voucher sold out while on the screen: ${m} gives the existing message, nothing charged`, async () => {
      let available = 10
      const w = world({ over: { rc: fakeRc({ availableCount: async () => available }) } })
      await walkCheck(w.deps, COMBO)
      await press(w.deps, "1")
      available = 0
      expect((await press(w.deps, m)).Message).toBe("WASSCE vouchers are sold out.\nPlease restart and use\nyour own voucher.")
      expect(w.sup.inserts["results_check_requests"]).toBeUndefined()
      expect(w.rpcCalls).toHaveLength(0)
    })
    it(`fee changed while on the screen: ${m} gives the existing message`, async () => {
      let fee = 2
      const w = world({ over: { rc: fakeRc({ checkSettings: async () => ({ enabled: true, fee }) }) } })
      await walkCheck(w.deps, COMBO)
      await press(w.deps, "1")
      fee = 3
      expect((await press(w.deps, m)).Message).toBe("Price changed to GHS 23.00. Please restart your order.")
      expect(w.rpcCalls).toHaveLength(0)
    })
    it(`service switched off while on the screen: ${m} gives the existing message`, async () => {
      let enabled = true
      const w = world({ over: { rc: fakeRc({ checkSettings: async () => ({ enabled, fee: 2 }) }) } })
      await walkCheck(w.deps, COMBO)
      await press(w.deps, "1")
      enabled = false
      expect((await press(w.deps, m)).Message).toBe("Results check is not available right now.")
      expect(w.rpcCalls).toHaveLength(0)
    })
    it(`caller no longer an account holder: ${m} gives the account-required text`, async () => {
      const w = world()
      await walkCheck(w.deps, COMBO)
      await press(w.deps, "1")
      w.resolveDialer.mockImplementation(async () => ({}))
      expect((await press(w.deps, m)).Message).toContain("create a Clingshub account")
      expect(w.rpcCalls).toHaveLength(0)
    })
  }
  it("a wallet-paid combo with no voucher left at fulfilment ends in needs_review with an URGENT alert", async () => {
    const handler = async () => { throw new Error("results_check_requests x paid (combo) but no voucher was in stock: assign one manually") }
    const w = world({ handlers: { results_check_requests: handler } })
    await walkCheck(w.deps, COMBO)
    await press(w.deps, "1")
    const r = await press(w.deps, "1")
    expect(r.Message).toBe(CHECK_PAID)
    await w.runDeferred()
    expect(w.payments[0].state).toBe("needs_review")
    expect(w.alert).toHaveBeenCalledWith(expect.stringContaining("URGENT"))
    expect(w.alert).toHaveBeenCalledWith(expect.stringContaining("GHS 22.00"))
  })
  it("an unregistered caller is still refused before any screen", async () => {
    const w = world({ dialer: async () => ({}) })
    await start(w.deps, "Results Checker")
    const r = await press(w.deps, "3")
    expect(r.Message).toContain("create a Clingshub account")
    expect(r.Type).toBe("release")
    expect(w.sup.inserts["results_check_requests"]).toBeUndefined()
    expect(w.rpcCalls).toHaveLength(0)
  })
})
