// lib/ussd-hubtel/flows/airtime.test.ts
import { describe, it, expect, vi } from "vitest"
import { DEFAULT_NETWORK_PREFIXES } from "@/lib/phone-format"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeAirtime, fakeSupabase, makeDeps, NEW_ID, OK_PKG, req } from "../testing/fakes"

async function toAirtime(deps: RouterDeps) {
  const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
  return hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Airtime") }), deps)
}
async function toConfirm(deps: RouterDeps, recipient = "0244123456", amount = "10") {
  await toAirtime(deps)
  await hubtelRouter(req({ Message: recipient }), deps)
  return hubtelRouter(req({ Message: amount }), deps)
}

describe("airtime: entry and recipient", () => {
  it("is on the main menu and asks for the recipient with a phone field", async () => {
    const { deps, store } = makeDeps()
    const r = await toAirtime(deps)
    expect(r.Message).toContain("Enter recipient number")
    expect(r.FieldType).toBe("phone")
    expect(store.get("S1")?.step).toBe("AIRTIME_ENTER_RECIPIENT")
  })
  it("is hidden when the admin turns airtime off", async () => {
    const { deps } = makeDeps({ getConfig: async () => ({ enabled: true, mode: "main", visibility: { data: true, afa: true, airtime: false, resultsChecker: true } }) })
    const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(menu.Message).not.toContain("Buy Airtime")
  })
  it("'0' goes back to the main menu", async () => {
    const { deps, store } = makeDeps()
    await toAirtime(deps)
    const r = await hubtelRouter(req({ Message: "0" }), deps)
    expect(r.Message).toContain("Buy Airtime")
    expect(store.get("S1")?.step).toBe("MAIN")
  })
  it("detects MTN from a 233... recipient and asks the amount with a decimal field", async () => {
    const { deps, store } = makeDeps()
    await toAirtime(deps)
    const r = await hubtelRouter(req({ Message: "233244123456" }), deps)
    expect(r.Message).toContain("MTN Airtime")
    expect(r.Message).toContain("(GHS 1 - 500)")
    expect(r.FieldType).toBe("decimal")
    expect(store.get("S1")).toMatchObject({ step: "AIRTIME_ENTER_AMOUNT", airtimeRecipient: "0244123456", airtimeNetwork: "MTN" })
  })
  it("rejects a malformed number and stays on the recipient step", async () => {
    const { deps, store } = makeDeps()
    await toAirtime(deps)
    const r = await hubtelRouter(req({ Message: "12345" }), deps)
    expect(r.Message).toContain("Invalid number.")
    expect(store.get("S1")?.step).toBe("AIRTIME_ENTER_RECIPIENT")
  })
  it("unknown prefix: asks the network (real names), then blocks the pair when prefix validation is on (review focus #3)", async () => {
    const { deps, store } = makeDeps()
    await toAirtime(deps)
    const menu = await hubtelRouter(req({ Message: "0230000000" }), deps)
    expect(menu.Message).toContain("Select recipient network")
    expect(menu.Message).toContain("1. MTN\n2. Telecel\n3. AT")
    for (const nick of ["Yellow Plans", "Instant Blue", "Delay Blue"]) expect(menu.Message).not.toContain(nick)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("doesn't match any Ghana mobile network")
    expect(store.get("S1")?.step).toBe("AIRTIME_ENTER_RECIPIENT")
  })
  it("unknown prefix with prefix validation off: the picked network is used", async () => {
    const { deps, store } = makeDeps({ getPrefixConfig: async () => ({ enabled: false, map: DEFAULT_NETWORK_PREFIXES }) })
    await toAirtime(deps)
    await hubtelRouter(req({ Message: "0230000000" }), deps)
    await hubtelRouter(req({ Message: "2" }), deps)
    expect(store.get("S1")).toMatchObject({ step: "AIRTIME_ENTER_AMOUNT", airtimeRecipient: "0230000000", airtimeNetwork: "Telecel" })
  })
  it("a network whose airtime is disabled re-prompts the recipient", async () => {
    const { deps, store } = makeDeps({ airtime: fakeAirtime({ isEnabled: async n => n !== "MTN" }) })
    await toAirtime(deps)
    const r = await hubtelRouter(req({ Message: "0244123456" }), deps)
    expect(r.Message).toContain("MTN airtime is unavailable.")
    expect(store.get("S1")?.step).toBe("AIRTIME_ENTER_RECIPIENT")
  })
})

describe("airtime: amount (review focus #3)", () => {
  for (const bad of ["0.5", "501", "abc", "10.555", "10abc", "-5"]) {
    it(`rejects "${bad}" and stays on the amount step`, async () => {
      const { deps, store } = makeDeps()
      await toAirtime(deps)
      await hubtelRouter(req({ Message: "0244123456" }), deps)
      const r = await hubtelRouter(req({ Message: bad }), deps)
      expect(r.Message).toContain("Enter a valid amount.")
      expect(store.get("S1")?.step).toBe("AIRTIME_ENTER_AMOUNT")
    })
  }
  it("confirm shows what the caller pays, what the recipient gets, and the payer", async () => {
    const { deps, store } = makeDeps()
    const r = await toConfirm(deps)
    expect(r.Message).toContain("MTN to 0244123456")
    expect(r.Message).toContain("You pay GHS 10.00")
    expect(r.Message).toContain("They get GHS 9.52") // 5% inclusive: fee 0.48
    expect(r.Message).toContain("from 0200585542")
    expect(r.Message).toContain("1. Pay now\n2. Cancel")
    expect(store.get("S1")).toMatchObject({ step: "AIRTIME_CONFIRM", airtimeAmount: 10, airtimeFee: 0.48, airtimeToDeliver: 9.52 })
  })
  it("dealers and sub-agents get the dealer fee rate", async () => {
    const feeRate = vi.fn(async () => 5)
    const { deps } = makeDeps({ airtime: fakeAirtime({ feeRate }), resolveDialer: async () => ({ userId: "u1", role: "sub_agent" }) })
    await toConfirm(deps)
    expect(feeRate).toHaveBeenCalledWith("MTN", true)
  })
})

describe("airtime: confirm -> AddToCart", () => {
  it("creates the airtime order + tx and returns AddToCart at the amount the caller pays (no fee added)", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps, store } = makeDeps({ resolveDialer: async () => ({ userId: "u1", email: "a@b.c" }) }, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "MTN Airtime to 0244123456", Qty: 1, Price: 10 })
    const row = sup.inserts["airtime_orders"][0]
    expect(row).toMatchObject({
      network: "MTN", beneficiary_phone: "0244123456", airtime_amount: 9.52, fee_amount: 0.48, total_paid: 10,
      pay_separately: false, status: "pending_payment", payment_status: "pending_payment",
      user_id: "u1", shop_id: null, merchant_commission: 0, customer_name: "USSD Customer", customer_email: "a@b.c",
      dialing_phone: "+233200585542", channel: "ussd",
    })
    expect(row.reference_code).toMatch(/^AT-/)
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({
      session_id: "S1", order_table: "airtime_orders", order_id: NEW_ID, expected_amount: 10, platform: "USSD",
    })
    expect(store.has("S1")).toBe(false)
  })
  it("'2' cancels without an order", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({}, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "2" }), deps)
    expect(r.Type).toBe("release")
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
})

describe("airtime: stale-session guard at confirm (review focus #2)", () => {
  it("limits lowered since the confirm screen: release, no order", async () => {
    let max = 500
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ airtime: fakeAirtime({ getLimits: async () => ({ min: 1, max }) }) }, sup)
    await toConfirm(deps)
    max = 5
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("Amount must be GHS 1-5")
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
  it("fee rate changed (recipient would get a different amount): release, no order", async () => {
    let rate = 5
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ airtime: fakeAirtime({ feeRate: async () => rate }) }, sup)
    await toConfirm(deps)
    rate = 10
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toMatch(/rates changed/i)
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
  it("(M1) a NaN fee rate at confirm fails closed: release, no order", async () => {
    let rate = 5
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ airtime: fakeAirtime({ feeRate: async () => rate }) }, sup)
    await toConfirm(deps)
    rate = NaN
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toMatch(/rates changed/i)
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
  it("(M1) a session that lost airtimeToDeliver fails closed at confirm: release, no order", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps, store } = makeDeps({}, sup)
    await toConfirm(deps)
    const s = store.get("S1")!
    store.set("S1", { ...s, airtimeToDeliver: undefined })
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toMatch(/rates changed/i)
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
  it("network disabled since the confirm screen: release, no order", async () => {
    let on = true
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ airtime: fakeAirtime({ isEnabled: async () => on }) }, sup)
    await toConfirm(deps)
    on = false
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("no longer available")
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
})

describe("airtime: idempotent CONFIRM (review focus #1)", () => {
  const winner = { order_table: "airtime_orders", order_id: "o-winner", expected_amount: 10, state: "awaiting_payment" }
  it("a duplicate '1' creates ONE order + ONE tx and replays the same AddToCart", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({}, sup)
    await toConfirm(deps)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    const second = await hubtelRouter(req({ Message: "1" }), deps)
    expect(second.Type).toBe("AddToCart")
    expect(second.Item).toEqual(first.Item)
    expect(sup.inserts["airtime_orders"]).toHaveLength(1)
    expect(sup.inserts["hubtel_transactions"]).toHaveLength(1)
  })
  it("a tx row already exists while the session is alive: CONFIRM's own guard replays, inserts nothing", async () => {
    const { deps } = makeDeps()
    await toConfirm(deps)
    // A concurrent request already wrote the order + tx for this session; the session is still alive.
    const withTx = fakeSupabase({ pkg: OK_PKG, rows: { hubtel_transactions: winner, airtime_orders: { network: "MTN", beneficiary_phone: "0244123456" } } })
    deps.supabase = withTx.client
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "MTN Airtime to 0244123456", Qty: 1, Price: 10 })
    expect(withTx.inserts["airtime_orders"]).toBeUndefined()
  })
  it("tx insert hits a unique violation: orphan airtime order failed, winner's cart replayed", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG, txConflictRow: winner })
    const { deps } = makeDeps({}, sup)
    await toConfirm(deps)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "MTN Airtime to 0244123456", Qty: 1, Price: 10 })
    expect(sup.updates.some(u => u.table === "airtime_orders" && u.patch.status === "failed" && u.patch.payment_status === "failed")).toBe(true)
  })
  it("session expired after AddToCart: the next '1' replays the AIRTIME cart, not the menu (review focus #6)", async () => {
    const sup = fakeSupabase({ rows: { hubtel_transactions: { ...winner, order_id: "o1" }, airtime_orders: { network: "Telecel", beneficiary_phone: "0201234567" } } })
    const { deps } = makeDeps({}, sup)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "Telecel Airtime to 0201234567", Qty: 1, Price: 10 })
  })
})
