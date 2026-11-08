// lib/ussd-hubtel/flows/pay-choice.test.ts
// Wallet or MoMo choice on the Hubtel main code, Data Bundles. Drives the real router with fakes.
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { USSD_SCREEN_LIMIT } from "../protocol"
import { RECIPIENT_BLOCKED_NOTE } from "../confirm-note"
import { fakeSupabase, makeDeps, NEW_ID, req } from "../testing/fakes"
import type { HubtelUssdConfig } from "../config"
import type { HubtelPlatform, HubtelReply } from "../types"
import { replaySubmittedOrder, type FlowCtx } from "../flow-kit"
import { checkoutOrChoose, choiceScreenText, INSUFFICIENT_TEXT, walletOfferFor } from "./pay-choice"

const CHOICE_42 = "Pay with:\n1. Datagod Wallet\n   (bal GHS 42.00)\n2. MoMo\n0. Cancel"
const PAID_DATA = "Payment successful.\nYour package will reflect\nin a few minutes."
const UNAVAILABLE = "Service unavailable. Please try again later."
const ALREADY = "This order was already submitted."

const config = (over: Partial<HubtelUssdConfig> = {}): HubtelUssdConfig => ({
  welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "main",
  visibility: { data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: true },
  walletPayment: true, ...over,
})

interface PayRow { id: string; session_id: string; order_table: string; order_id: string; user_id: string; amount: number; state: string; updated_at: string; created_at: string }
type RpcResult = { data: any; error: any }

/**
 * Fake world: fakeSupabase plus the wallet RPC and a hubtel_wallet_payments table (read by session, state moves).
 * The default RPC debits like the real one: a session's second call is a replay of the first payment.
 */
function world(o: {
  pkg?: { price: number; dealer_price: null; is_available: boolean }
  balance?: number
  dialer?: RouterDeps["resolveDialer"]
  rpc?: (args: any) => Promise<RpcResult> | RpcResult
  paymentsReadError?: boolean
  existingPayment?: Partial<PayRow>
  cfg?: Partial<HubtelUssdConfig>
  defer?: boolean
  handler?: (id: string) => Promise<void>
  bundlePrice?: number
  verifyRecipient?: RouterDeps["verifyRecipient"]
} = {}) {
  const pkg = o.pkg ?? { price: 10, dealer_price: null, is_available: true }
  const sup = fakeSupabase({ pkg })
  const payments: PayRow[] = []
  if (o.existingPayment) {
    payments.push({ id: "pay-0", session_id: "S1", order_table: "ussd_orders", order_id: "old", user_id: "user-1", amount: 10, state: "debited", created_at: "", updated_at: "", ...o.existingPayment })
  }
  const rpcCalls: any[] = []
  const state = { paymentsReadError: o.paymentsReadError === true, walletTableCalls: 0 }
  const baseFrom = sup.client.from.bind(sup.client)
  sup.client.from = (table: string) => {
    if (table !== "hubtel_wallet_payments") return baseFrom(table)
    state.walletTableCalls++
    const filters: Record<string, unknown> = {}
    let patch: any = null
    const match = () => payments.filter(p => Object.entries(filters).every(([k, v]) => (p as any)[k] === v))
    const b: any = {
      select() { return b },
      eq(c: string, v: unknown) { filters[c] = v; return b },
      update(p: any) { patch = p; return b },
      maybeSingle: async () => (state.paymentsReadError ? { data: null, error: { message: "read failed" } } : { data: match()[0] ?? null, error: null }),
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
  const defaultRpc = (a: any): RpcResult => {
    const prior = payments.find(p => p.session_id === a.p_session)
    if (prior) {
      if (prior.order_id !== a.p_order) return { data: null, error: { message: "BAD_INPUT" } }
      return { data: { payment_id: prior.id, replay: true }, error: null }
    }
    const id = `pay-${payments.length + 1}`
    payments.push({ id, session_id: a.p_session, order_table: a.p_table, order_id: a.p_order, user_id: a.p_user, amount: a.p_amount, state: "debited", created_at: "", updated_at: "" })
    return { data: { payment_id: id, replay: false, new_balance: 0 }, error: null }
  }
  sup.client.rpc = vi.fn(async (name: string, args: any) => {
    rpcCalls.push({ name, args })
    return o.rpc ? o.rpc(args) : defaultRpc(args)
  })
  const handler = vi.fn(o.handler ?? (async () => undefined))
  const alert = vi.fn(async () => undefined)
  const deferred: Array<() => Promise<unknown>> = []
  const resolveDialer = vi.fn(o.dialer ?? (async () => ({ userId: "user-1", balance: o.balance ?? 42 })))
  const getConfig = vi.fn(async () => config(o.cfg))
  const { deps, store } = makeDeps({
    getConfig,
    resolveDialer,
    walletPayDeps: () => ({ db: sup.client, handlers: { ussd_orders: handler }, alert }),
    ...(o.bundlePrice !== undefined ? { fetchBundles: async () => ({ bundles: [{ id: "pkg-1", size: "5", price: o.bundlePrice! }], total: 1 }) } : {}),
    ...(o.verifyRecipient ? { verifyRecipient: o.verifyRecipient } : {}),
    ...(o.defer === false ? {} : { defer: (t: () => Promise<unknown>) => { deferred.push(t) } }),
  }, sup)
  const runDeferred = async () => { while (deferred.length) await deferred.shift()!() }
  return { deps, store, sup, pkg, payments, rpcCalls, handler, alert, deferred, runDeferred, resolveDialer, getConfig, state }
}

/** Initiation -> data -> MTN -> first bundle -> someone else -> 0244123456: the data confirm screen. */
async function walkToConfirm(deps: RouterDeps, platform: HubtelPlatform = "USSD") {
  const r = (over: Parameters<typeof req>[0]) => hubtelRouter(req({ Platform: platform, ...over }), deps)
  await r({ Type: "Initiation" })
  await r({ Message: "1" })
  await r({ Message: "1" })
  await r({ Message: "1" })
  await r({ Message: "2" })
  return r({ Message: "0244123456" })
}
const press = (deps: RouterDeps, m: string, platform: HubtelPlatform = "USSD") => hubtelRouter(req({ Message: m, Platform: platform }), deps)

/** The MoMo AddToCart a switch-off caller gets today. */
async function todaysCart(): Promise<HubtelReply> {
  const w = world({ cfg: { walletPayment: undefined } })
  await walkToConfirm(w.deps)
  return press(w.deps, "1")
}

describe("pay choice: callers who are not offered the wallet get today's checkout", () => {
  it("switch off: AddToCart exactly as today, and no wallet or balance read", async () => {
    const w = world({ cfg: { walletPayment: false } })
    await walkToConfirm(w.deps)
    const r = await press(w.deps, "1")
    expect(r).toEqual(await todaysCart())
    expect(r.Type).toBe("AddToCart")
    expect(w.resolveDialer).not.toHaveBeenCalled()
    expect(w.rpcCalls).toHaveLength(0)
    expect(w.sup.inserts["hubtel_transactions"]).toHaveLength(1)
  })
  it("switch missing: same", async () => {
    const w = world({ cfg: { walletPayment: undefined } })
    await walkToConfirm(w.deps)
    expect((await press(w.deps, "1")).Type).toBe("AddToCart")
    expect(w.resolveDialer).not.toHaveBeenCalled()
  })
  it("Platform Webstore: AddToCart, no balance read", async () => {
    const w = world()
    await walkToConfirm(w.deps, "Webstore")
    const r = await press(w.deps, "1", "Webstore")
    expect(r.Type).toBe("AddToCart")
    expect(w.resolveDialer).not.toHaveBeenCalled()
  })
  it("unregistered caller: AddToCart", async () => {
    const w = world({ dialer: async () => ({}) })
    await walkToConfirm(w.deps)
    const r = await press(w.deps, "1")
    expect(r).toEqual(await todaysCart())
    expect(w.store.has("S1")).toBe(false)
  })
  it("balance one pesewa short: AddToCart", async () => {
    const w = world({ balance: 9.99 })
    await walkToConfirm(w.deps)
    expect((await press(w.deps, "1")).Type).toBe("AddToCart")
    expect(w.rpcCalls).toHaveLength(0)
  })
  it("balance exactly the price: offered", async () => {
    const w = world({ balance: 10 })
    await walkToConfirm(w.deps)
    expect((await press(w.deps, "1")).Message).toBe("Pay with:\n1. Datagod Wallet\n   (bal GHS 10.00)\n2. MoMo\n0. Cancel")
  })
  it("a failed balance read means no offer: AddToCart", async () => {
    const w = world({ dialer: async () => { throw new Error("db down") } })
    await walkToConfirm(w.deps)
    expect((await press(w.deps, "1")).Type).toBe("AddToCart")
  })
  it("no wallet payment deps wired: AddToCart, no balance read", async () => {
    const w = world()
    delete (w.deps as Partial<RouterDeps>).walletPayDeps
    await walkToConfirm(w.deps)
    expect((await press(w.deps, "1")).Type).toBe("AddToCart")
    expect(w.resolveDialer).not.toHaveBeenCalled()
  })
})

describe("pay choice: the screen", () => {
  it("eligible caller: exact screen, step PAY_CHOICE, no order created", async () => {
    const w = world()
    await walkToConfirm(w.deps)
    const r = await press(w.deps, "1")
    expect(r.Type).toBe("response")
    expect(r.Message).toBe(CHOICE_42)
    expect(r.ClientState).toBe("PAY_CHOICE")
    expect(w.store.get("S1")).toMatchObject({ step: "PAY_CHOICE", payKind: "data" })
    expect(w.sup.inserts["ussd_orders"]).toBeUndefined()
    expect(w.sup.inserts["hubtel_transactions"]).toBeUndefined()
    expect(w.rpcCalls).toHaveLength(0)
  })
  it("2 gives the same AddToCart as today, and no wallet call (Review Focus 3)", async () => {
    const w = world()
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    const r = await press(w.deps, "2")
    expect(r).toEqual(await todaysCart())
    expect(w.rpcCalls).toHaveLength(0)
    expect(w.sup.inserts["ussd_orders"]).toHaveLength(1)
    expect(w.sup.inserts["hubtel_transactions"][0]).toMatchObject({ session_id: "S1", order_table: "ussd_orders", order_id: NEW_ID, expected_amount: 10 })
    expect(w.store.has("S1")).toBe(false)
  })
  it("0 cancels with nothing created", async () => {
    const w = world()
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    const r = await press(w.deps, "0")
    expect(r.Type).toBe("release")
    expect(r.Message).toBe("Order cancelled.")
    expect(w.sup.inserts["ussd_orders"]).toBeUndefined()
    expect(w.rpcCalls).toHaveLength(0)
    expect(w.store.has("S1")).toBe(false)
  })
  it("any other input repaints", async () => {
    const w = world()
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    for (const bad of ["9", "abc", ""]) {
      const r = await press(w.deps, bad)
      expect(r.Message).toBe(CHOICE_42)
      expect(r.ClientState).toBe("PAY_CHOICE")
    }
    expect(w.sup.inserts["ussd_orders"]).toBeUndefined()
  })
  it("a session with mode missing after Back counts as main mode", async () => {
    const w = world()
    const r = (m: string, Type: "Initiation" | "Response" = "Response") => hubtelRouter(req({ Type, Message: m }), w.deps)
    await r("", "Initiation")
    await r("1") // data -> networks
    await r("0") // back to the main menu: the clean session has no mode
    expect(w.store.get("S1")?.mode).toBeUndefined()
    await r("1"); await r("1"); await r("1"); await r("2"); await r("0244123456")
    expect(w.store.get("S1")?.mode).toBeUndefined()
    expect((await r("1")).Message).toBe(CHOICE_42)
  })
  it("every new screen fits 182 characters with a 7-digit balance", () => {
    expect(choiceScreenText(1234567.89).length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
    expect(choiceScreenText(9999999.99)).toContain("(bal GHS 9999999.99)")
    expect(INSUFFICIENT_TEXT.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
    expect(PAID_DATA.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
    for (const s of [choiceScreenText(1234567.89), INSUFFICIENT_TEXT]) expect(s).toMatch(/^[\x20-\x7e\n]+$/)
  })
  it("a 7-digit balance screen is sent whole", async () => {
    const w = world({ balance: 1234567.89 })
    await walkToConfirm(w.deps)
    const r = await press(w.deps, "1")
    expect(r.Message).toBe("Pay with:\n1. Datagod Wallet\n   (bal GHS 1234567.89)\n2. MoMo\n0. Cancel")
  })
})

describe("pay choice: 1 pays from the wallet", () => {
  it("creates the order, debits the screen's price, says Payment successful, and defers post-payment", async () => {
    const w = world()
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    const r = await press(w.deps, "1")
    expect(r.Type).toBe("release")
    expect(r.Message).toBe(PAID_DATA)
    expect(w.sup.inserts["ussd_orders"]).toHaveLength(1)
    expect(w.sup.inserts["ussd_orders"][0]).toMatchObject({ amount: 10, order_status: "pending", payment_status: "pending", recipient_phone: "0244123456" })
    expect(w.sup.inserts["hubtel_transactions"]).toBeUndefined()
    expect(w.rpcCalls).toHaveLength(1)
    expect(w.rpcCalls[0]).toMatchObject({
      name: "pay_hubtel_order_from_wallet",
      args: { p_session: "S1", p_user: "user-1", p_table: "ussd_orders", p_order: NEW_ID, p_amount: 10, p_source: "ussd_data_purchase" },
    })
    expect(typeof w.rpcCalls[0].args.p_description).toBe("string")
    expect(w.store.has("S1")).toBe(false)
    // Post-payment waits for the deferred run.
    expect(w.handler).not.toHaveBeenCalled()
    expect(w.deferred).toHaveLength(1)
    await w.runDeferred()
    expect(w.handler).toHaveBeenCalledWith(NEW_ID)
    expect(w.payments[0].state).toBe("fulfilled")
  })
  it("without defer, post-payment is awaited before the reply", async () => {
    const w = world({ defer: false })
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    const r = await press(w.deps, "1")
    expect(r.Message).toBe(PAID_DATA)
    expect(w.handler).toHaveBeenCalledWith(NEW_ID)
    expect(w.payments[0].state).toBe("fulfilled")
  })
  it("a post-payment failure still answers Payment successful and alerts with the amount", async () => {
    const w = world({ defer: false, handler: async () => { throw new Error("fulfil down") } })
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    expect((await press(w.deps, "1")).Message).toBe(PAID_DATA)
    expect(w.payments[0].state).toBe("needs_review")
    expect(w.alert).toHaveBeenCalledWith(expect.stringContaining("GHS 10.00"))
  })
  it("the amount sent is pesewa-clean", async () => {
    const w = world({ pkg: { price: 3.3000000000000003, dealer_price: null, is_available: true }, bundlePrice: 3.3 })
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    await press(w.deps, "1")
    expect(w.rpcCalls[0].args.p_amount).toBe(3.3)
  })
  it("insufficient: fails the just-created order guarded and offers MoMo or Cancel (Review Focus 1)", async () => {
    const w = world({ rpc: () => ({ data: null, error: { message: "INSUFFICIENT_FUNDS" } }) })
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    const r = await press(w.deps, "1")
    expect(r.Type).toBe("response")
    expect(r.Message).toBe("Insufficient balance.\n2. MoMo\n0. Cancel")
    expect(r.ClientState).toBe("PAY_CHOICE")
    const fail = w.sup.updates.find(u => u.table === "ussd_orders")
    expect(fail?.patch).toMatchObject({ order_status: "failed", payment_status: "failed" })
    expect((fail as any).filters).toContainEqual(["eq", "id", NEW_ID])
    expect(w.handler).not.toHaveBeenCalled()
    expect(w.deferred).toHaveLength(0)
    // 1 again does not retry the wallet; any input repaints the same screen.
    expect((await press(w.deps, "1")).Message).toBe("Insufficient balance.\n2. MoMo\n0. Cancel")
    expect((await press(w.deps, "5")).Message).toBe("Insufficient balance.\n2. MoMo\n0. Cancel")
    expect(w.rpcCalls).toHaveLength(1)
    // 2 still pays by MoMo.
    const cart = await press(w.deps, "2")
    expect(cart.Type).toBe("AddToCart")
    expect(cart.Item?.Price).toBe(10)
    expect(w.sup.inserts["hubtel_transactions"]).toHaveLength(1)
  })
  it("insufficient then 0 cancels", async () => {
    const w = world({ rpc: () => ({ data: null, error: { message: "INSUFFICIENT_FUNDS" } }) })
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    await press(w.deps, "1")
    expect((await press(w.deps, "0")).Message).toBe("Order cancelled.")
  })
  it("refused: fails the order guarded and ends with the unavailable text", async () => {
    const w = world({ rpc: () => ({ data: null, error: { message: "ALREADY_CARTED" } }) })
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    const r = await press(w.deps, "1")
    expect(r.Type).toBe("release")
    expect(r.Message).toBe(UNAVAILABLE)
    expect(w.sup.updates.find(u => u.table === "ussd_orders")?.patch).toMatchObject({ payment_status: "failed" })
    expect(w.handler).not.toHaveBeenCalled()
    expect(w.store.has("S1")).toBe(false)
  })
  it("unavailable with no debit: fails the order guarded and ends with the unavailable text", async () => {
    const w = world({ rpc: () => { throw new Error("socket hang up") } })
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    const r = await press(w.deps, "1")
    expect(r.Message).toBe(UNAVAILABLE)
    expect(r.Type).toBe("release")
    expect(w.sup.updates.find(u => u.table === "ussd_orders")?.patch).toMatchObject({ order_status: "failed", payment_status: "failed" })
    expect(w.handler).not.toHaveBeenCalled()
  })
  it("unavailable with the debit uncertain: leaves the order for the sweep and ends with the unavailable text", async () => {
    const w = world({ rpc: (a: any) => { w.state.paymentsReadError = true; void a; throw new Error("socket hang up") } })
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    const r = await press(w.deps, "1")
    expect(r.Message).toBe(UNAVAILABLE)
    expect(w.sup.updates.filter(u => u.table === "ussd_orders")).toHaveLength(0)
    expect(w.alert).toHaveBeenCalled()
    expect(w.handler).not.toHaveBeenCalled()
  })
  it("an unknown error with the payment found counts as paid", async () => {
    const w = world({
      rpc: (a: any) => {
        w.payments.push({ id: "pay-9", session_id: a.p_session, order_table: a.p_table, order_id: a.p_order, user_id: a.p_user, amount: a.p_amount, state: "debited", created_at: "", updated_at: "" })
        throw new Error("timeout")
      },
    })
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    expect((await press(w.deps, "1")).Message).toBe(PAID_DATA)
    await w.runDeferred()
    expect(w.handler).toHaveBeenCalledWith(NEW_ID)
  })
  it("an RPC replay answers Payment successful without running post-payment again", async () => {
    const w = world({ rpc: () => ({ data: { payment_id: "pay-1", replay: true }, error: null }) })
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    expect((await press(w.deps, "1")).Message).toBe(PAID_DATA)
    expect(w.deferred).toHaveLength(0)
    expect(w.handler).not.toHaveBeenCalled()
  })
  it("the switch turned off while on the screen: 1 creates nothing and debits nothing", async () => {
    const w = world()
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    w.getConfig.mockImplementation(async () => config({ walletPayment: false }))
    const r = await press(w.deps, "1")
    expect(r.Message).toBe(UNAVAILABLE)
    expect(w.sup.inserts["ussd_orders"]).toBeUndefined()
    expect(w.rpcCalls).toHaveLength(0)
  })
  it("the caller no longer resolves to an account: 1 creates nothing", async () => {
    const w = world()
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    w.resolveDialer.mockImplementation(async () => ({}))
    expect((await press(w.deps, "1")).Message).toBe(UNAVAILABLE)
    expect(w.sup.inserts["ussd_orders"]).toBeUndefined()
    expect(w.rpcCalls).toHaveLength(0)
  })
  it("the order insert fails: nothing debited", async () => {
    const w = world()
    w.sup.client.from = ((orig) => (t: string) => {
      const b = orig(t)
      if (t === "ussd_orders") b.insert = () => ({ select: () => ({ single: async () => ({ data: null, error: { message: "insert failed" } }) }) })
      return b
    })(w.sup.client.from)
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    expect((await press(w.deps, "1")).Message).toBe("Error creating order. Please try again.")
    expect(w.rpcCalls).toHaveLength(0)
  })
})

describe("pay choice: one payment per session (Review Focus 2)", () => {
  it("a repeat of 1 after the reply was lost (session gone): already submitted, no second debit", async () => {
    const w = world()
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    await press(w.deps, "1")
    expect(w.store.has("S1")).toBe(false)
    const r = await press(w.deps, "1")
    expect(r.Type).toBe("release")
    expect(r.Message).toBe(ALREADY)
    expect(w.rpcCalls).toHaveLength(1)
    expect(w.sup.inserts["ussd_orders"]).toHaveLength(1)
  })
  it("a repeat of 1 with the session still on PAY_CHOICE: already submitted, no second order or debit", async () => {
    const w = world()
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    const screen = w.store.get("S1")!
    await press(w.deps, "1")
    w.store.set("S1", screen)
    for (const m of ["1", "2"]) {
      w.store.set("S1", screen)
      const r = await press(w.deps, m)
      expect(r.Message).toBe(ALREADY)
    }
    expect(w.rpcCalls).toHaveLength(1)
    expect(w.sup.inserts["ussd_orders"]).toHaveLength(1)
    expect(w.sup.inserts["hubtel_transactions"]).toBeUndefined()
  })
  it("a wallet-paid session never carts at the data confirm, even with the switch off", async () => {
    const w = world({ cfg: { walletPayment: false } })
    await walkToConfirm(w.deps)
    w.payments.push({ id: "pay-x", session_id: "S1", order_table: "ussd_orders", order_id: "o", user_id: "u", amount: 10, state: "fulfilled", created_at: "", updated_at: "" })
    const r = await press(w.deps, "1")
    expect(r.Type).toBe("release")
    expect(r.Message).toBe(ALREADY)
    expect(w.sup.inserts["ussd_orders"]).toBeUndefined()
    expect(w.sup.inserts["hubtel_transactions"]).toBeUndefined()
  })
  it("a failed wallet-payment read at confirm fails closed: unavailable, never carts", async () => {
    const w = world({ cfg: { walletPayment: false } })
    await walkToConfirm(w.deps)
    w.state.paymentsReadError = true
    const r = await press(w.deps, "1")
    expect(r.Type).toBe("release")
    expect(r.Message).toBe(UNAVAILABLE)
    expect(w.sup.inserts["ussd_orders"]).toBeUndefined()
    expect(w.sup.inserts["hubtel_transactions"]).toBeUndefined()
    expect(w.store.has("S1")).toBe(false)
  })
  it("a failed wallet-payment read on 2 fails closed too", async () => {
    const w = world()
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    w.state.paymentsReadError = true
    expect((await press(w.deps, "2")).Message).toBe(UNAVAILABLE)
    expect(w.sup.inserts["hubtel_transactions"]).toBeUndefined()
  })
  it("the hubtel_transactions replay still comes first", async () => {
    const w = world()
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    await press(w.deps, "2") // carted
    const r = await press(w.deps, "1") // lost reply: replays the cart
    expect(r.Type).toBe("AddToCart")
    expect(w.rpcCalls).toHaveLength(0)
  })
})

describe("pay choice: checks run again on 1 and 2 (Review Focus 4)", () => {
  for (const m of ["1", "2"]) {
    it(`price changed while on the screen: ${m} gives the existing message, no charge`, async () => {
      const w = world()
      await walkToConfirm(w.deps)
      await press(w.deps, "1")
      w.pkg.price = 12
      const r = await press(w.deps, m)
      expect(r.Type).toBe("release")
      expect(r.Message).toBe("Price changed to GHS 12.00. Please restart your order.")
      expect(w.sup.inserts["ussd_orders"]).toBeUndefined()
      expect(w.rpcCalls).toHaveLength(0)
    })
    it(`package withdrawn while on the screen: ${m} gives the existing message`, async () => {
      const w = world()
      await walkToConfirm(w.deps)
      await press(w.deps, "1")
      w.pkg.is_available = false
      expect((await press(w.deps, m)).Message).toBe("Package no longer available. Please try again.")
      expect(w.rpcCalls).toHaveLength(0)
    })
    it(`MTN recipient blocked while on the screen: ${m} re-prompts, no charge`, async () => {
      let verdict: boolean | "blocked" = true
      const w = world({ verifyRecipient: async () => verdict })
      await walkToConfirm(w.deps)
      expect((await press(w.deps, "1")).Message).toBe(CHOICE_42)
      verdict = "blocked"
      const r = await press(w.deps, m)
      expect(r.Message).toContain(RECIPIENT_BLOCKED_NOTE)
      expect(w.store.get("S1")?.step).toBe("ENTER_RECIPIENT")
      expect(w.sup.inserts["ussd_orders"]).toBeUndefined()
      expect(w.rpcCalls).toHaveLength(0)
    })
  }
})

/** Would this update's .eq/.in filters match `row`? (The fake records them; this evaluates them.) */
function filtersMatch(update: unknown, row: Record<string, unknown>): boolean {
  const filters = (update as { filters: Array<[string, string, unknown]> }).filters
  return filters.every(([op, col, v]) => (op === "eq" ? row[col] === v : (v as unknown[]).includes(row[col])))
}

describe("pay choice: fix round 1", () => {
  /** An RPC that loses a race: another request for this session paid (its own order) just before. */
  const lostRace = (w: () => ReturnType<typeof world>, reply: () => RpcResult) => (a: any): RpcResult => {
    w().payments.push({ id: "pay-other", session_id: a.p_session, order_table: "ussd_orders", order_id: "other-order", user_id: a.p_user, amount: a.p_amount, state: "debited", created_at: "", updated_at: "" })
    return reply()
  }

  it("refused (BAD_INPUT) while this session already holds a payment: already submitted, this order failed", async () => {
    let w!: ReturnType<typeof world>
    w = world({ rpc: lostRace(() => w, () => ({ data: null, error: { message: "BAD_INPUT" } })) })
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    const r = await press(w.deps, "1")
    expect(r.Type).toBe("release")
    expect(r.Message).toBe(ALREADY)
    expect(w.sup.updates.find(u => u.table === "ussd_orders")?.patch).toMatchObject({ payment_status: "failed" })
    expect(w.handler).not.toHaveBeenCalled()
    expect(w.store.has("S1")).toBe(false)
  })
  it("plain unavailable while another request paid: the read-back sees another order (refused), so already submitted", async () => {
    let w!: ReturnType<typeof world>
    w = world({ rpc: lostRace(() => w, () => { throw new Error("socket hang up") }) })
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    expect((await press(w.deps, "1")).Message).toBe(ALREADY)
    expect(w.handler).not.toHaveBeenCalled()
  })
  it("plain unavailable (no row anywhere), then the re-read still finds nothing: unavailable", async () => {
    const w = world({ rpc: () => ({ data: null, error: { message: "something odd" } }) })
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    expect((await press(w.deps, "1")).Message).toBe(UNAVAILABLE)
  })
  it("refused, and the re-read fails: keeps the unavailable text", async () => {
    let w!: ReturnType<typeof world>
    w = world({ rpc: () => { w.state.paymentsReadError = true; return { data: null, error: { message: "BAD_INPUT" } } } })
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    expect((await press(w.deps, "1")).Message).toBe(UNAVAILABLE)
  })

  for (const [name, rpc] of [
    ["insufficient", () => ({ data: null, error: { message: "INSUFFICIENT_FUNDS" } })],
    ["refused", () => ({ data: null, error: { message: "ALREADY_CARTED" } })],
    ["plain unavailable", () => { throw new Error("socket hang up") }],
  ] as Array<[string, () => RpcResult]>) {
    it(`${name}: the fail is guarded on payable statuses, so a completed order is never touched`, async () => {
      const w = world({ rpc })
      await walkToConfirm(w.deps)
      await press(w.deps, "1")
      await press(w.deps, "1")
      const fail = w.sup.updates.find(u => u.table === "ussd_orders")!
      expect((fail as any).filters).toContainEqual(["in", "payment_status", ["pending", "otp_required"]])
      expect(filtersMatch(fail, { id: NEW_ID, payment_status: "completed" })).toBe(false)
      expect(filtersMatch(fail, { id: NEW_ID, payment_status: "pending" })).toBe(true)
    })
  }

  it("the wallet path's order row records the debited (rounded) amount", async () => {
    const w = world({ pkg: { price: 3.3000000000000003, dealer_price: null, is_available: true }, bundlePrice: 3.3 })
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    await press(w.deps, "1")
    expect(w.sup.inserts["ussd_orders"][0].amount).toBe(3.3)
    expect(w.rpcCalls[0].args.p_amount).toBe(w.sup.inserts["ussd_orders"][0].amount)
  })
  it("the MoMo path's order row is unchanged (prepare's value)", async () => {
    const w = world({ pkg: { price: 3.3000000000000003, dealer_price: null, is_available: true }, bundlePrice: 3.3 })
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    await press(w.deps, "2")
    expect(w.sup.inserts["ussd_orders"][0].amount).toBe(3.3000000000000003)
  })

  /** Shop code 1234 -> Internet Bundles -> MTN -> first package -> someone else -> number. */
  async function shopConfirm(deps: RouterDeps) {
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    const menu = await hubtelRouter(req({ Message: "1234" }), deps)
    const internet = menu.Message.split("\n").find(l => l.endsWith("Internet Bundles"))!.split(".")[0]
    await hubtelRouter(req({ Message: internet }), deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    await hubtelRouter(req({ Message: "2" }), deps)
    return hubtelRouter(req({ Message: "0244123456" }), deps)
  }
  it("a shop-mode confirm makes no hubtel_wallet_payments read", async () => {
    const w = world({ cfg: { mode: "shop" } })
    await shopConfirm(w.deps)
    expect(w.store.get("S1")).toMatchObject({ mode: "shop", step: "SHOP_DATA_CONFIRM" })
    const r = await press(w.deps, "1")
    expect(r.Type).toBe("AddToCart")
    expect(w.state.walletTableCalls).toBe(0)
  })
  it("a wallet lookup error cannot end a shop-line session", async () => {
    const w = world({ cfg: { mode: "shop" }, paymentsReadError: true })
    await shopConfirm(w.deps)
    const r = await press(w.deps, "1")
    expect(r.Type).toBe("AddToCart")
    expect(r.Message).not.toBe(UNAVAILABLE)
  })
  it("replaySubmittedOrder: mode shop skips the lookup; no mode or main keeps it (fail closed)", async () => {
    const w = world({ paymentsReadError: true })
    expect(await replaySubmittedOrder(w.deps, "S1", "USSD", "shop")).toBeNull()
    expect(w.state.walletTableCalls).toBe(0)
    expect((await replaySubmittedOrder(w.deps, "S1", "USSD"))?.Message).toBe(UNAVAILABLE)
    expect((await replaySubmittedOrder(w.deps, "S1", "USSD", "main"))?.Message).toBe(UNAVAILABLE)
    expect(w.state.walletTableCalls).toBe(2)
  })
})

describe("pay choice: helpers", () => {
  function ctxOf(w: ReturnType<typeof world>, over: { mode?: "main" | "shop"; platform?: HubtelPlatform; cfg?: Partial<HubtelUssdConfig> } = {}): FlowCtx {
    return {
      input: "1",
      req: req({ Message: "1", Platform: over.platform ?? "USSD" }),
      deps: w.deps,
      config: config(over.cfg),
      session: { step: "CONFIRM", dialingPhone: "+233200585542", platform: "USSD", ...(over.mode ? { mode: over.mode } : {}) },
    }
  }
  it("walletOfferFor: the balance and user when eligible", async () => {
    const w = world()
    expect(await walletOfferFor(ctxOf(w), 10)).toEqual({ userId: "user-1", balance: 42 })
  })
  it("walletOfferFor: null with the switch off, without reading", async () => {
    const w = world()
    expect(await walletOfferFor(ctxOf(w, { cfg: { walletPayment: false } }), 10)).toBeNull()
    expect(w.resolveDialer).not.toHaveBeenCalled()
  })
  it("walletOfferFor: null in shop mode and on Webstore, without reading", async () => {
    const w = world()
    expect(await walletOfferFor(ctxOf(w, { mode: "shop" }), 10)).toBeNull()
    expect(await walletOfferFor(ctxOf(w, { platform: "Webstore" }), 10)).toBeNull()
    expect(w.resolveDialer).not.toHaveBeenCalled()
  })
  it("walletOfferFor: null for a non-positive or unreadable balance or price", async () => {
    const w = world({ dialer: async () => ({ userId: "user-1", balance: Number.NaN }) })
    expect(await walletOfferFor(ctxOf(w), 10)).toBeNull()
    const w2 = world()
    expect(await walletOfferFor(ctxOf(w2), 0)).toBeNull()
  })
  it("checkoutOrChoose: shop mode goes to checkout", async () => {
    const w = world()
    const r = await checkoutOrChoose(ctxOf(w, { mode: "shop" }), "data", async () => ({ table: "ussd_orders", row: { a: 1 }, price: 10, logTag: "T" }))
    expect(r.Type).toBe("AddToCart")
    expect(w.resolveDialer).not.toHaveBeenCalled()
  })
  it("checkoutOrChoose: a table outside the wallet tables never offers the wallet", async () => {
    const w = world()
    const r = await checkoutOrChoose(ctxOf(w), "data", async () => ({ table: "ussd_afa_orders", row: { a: 1 }, price: 10, logTag: "T" }))
    expect(r.Type).toBe("AddToCart")
    expect(w.resolveDialer).not.toHaveBeenCalled()
  })
  it("checkoutOrChoose: a reply from prepare is returned as is", async () => {
    const w = world()
    const reply: HubtelReply = { SessionId: "S1", Type: "release", Message: "nope", Label: "x", DataType: "display", FieldType: "text" }
    expect(await checkoutOrChoose(ctxOf(w), "data", async () => reply)).toBe(reply)
    expect(w.sup.inserts["ussd_orders"]).toBeUndefined()
  })
  it("PAY_CHOICE with no prepare for the session's kind ends with the unavailable text, nothing created", async () => {
    const w = world()
    await walkToConfirm(w.deps)
    await press(w.deps, "1")
    w.store.set("S1", { ...w.store.get("S1")!, payKind: "rc" })
    for (const m of ["1", "2"]) {
      w.store.set("S1", { ...w.store.get("S1") ?? { step: "PAY_CHOICE", dialingPhone: "+233200585542", platform: "USSD" }, step: "PAY_CHOICE", payKind: "rc" })
      expect((await press(w.deps, m)).Message).toBe(UNAVAILABLE)
    }
    expect(w.sup.inserts["ussd_orders"]).toBeUndefined()
    expect(w.rpcCalls).toHaveLength(0)
  })
  it("PAY_CHOICE is not a shop step", async () => {
    const w = world()
    w.store.set("S1", { step: "PAY_CHOICE", payKind: "data", mode: "shop", dialingPhone: "+233200585542", platform: "USSD" })
    await press(w.deps, "1")
    expect(w.rpcCalls).toHaveLength(0)
    expect(w.sup.inserts["ussd_orders"]).toBeUndefined()
  })
})
