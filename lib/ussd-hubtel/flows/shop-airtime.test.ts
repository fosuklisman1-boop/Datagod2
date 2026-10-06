// lib/ussd-hubtel/flows/shop-airtime.test.ts
import { describe, it, expect, vi } from "vitest"
import { DEFAULT_NETWORK_PREFIXES } from "@/lib/phone-format"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeAirtime, fakeShop, fakeSupabase, makeDeps, NEW_ID, OK_PKG, req, SHOP_CODE, SHOP_CONFIG } from "../testing/fakes"

const shopDeps = (over: Parameters<typeof makeDeps>[0] = {}, sup = fakeSupabase({ pkg: OK_PKG })) =>
  makeDeps({ getConfig: SHOP_CONFIG, ...over }, sup)

async function toAirtime(deps: RouterDeps) {
  await hubtelRouter(req({ Type: "Initiation" }), deps)
  const menu = await hubtelRouter(req({ Message: "1234" }), deps)
  return hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Airtime") }), deps)
}
async function toConfirm(deps: RouterDeps, recipient = "0244123456", amount = "10") {
  await toAirtime(deps)
  await hubtelRouter(req({ Message: recipient }), deps)
  return hubtelRouter(req({ Message: amount }), deps)
}

describe("shop airtime: recipient", () => {
  it("asks for the recipient under the shop header, phone field", async () => {
    const { deps, store } = shopDeps()
    const r = await toAirtime(deps)
    expect(r.Message).toBe("Ama Data Hub\nBuy Airtime\nEnter recipient number:\n0. Back")
    expect(r.FieldType).toBe("phone")
    expect(store.get("S1")?.step).toBe("SHOP_AIRTIME_ENTER_RECIPIENT")
  })
  it("the shop name is sanitised on screen (non-ASCII stripped, whitespace collapsed)", async () => {
    const { deps } = shopDeps({ shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, shopName: "Ama’s   Data  Hub ✓" }) }) })
    const r = await toAirtime(deps)
    expect(r.Message.split("\n")[0]).toBe("Amas Data Hub")
    expect(r.Message).toMatch(/^[\x20-\x7E\n]*$/)
  })
  it("'0' returns to the product menu without billing again", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps, store } = shopDeps({ shop: fakeShop({ deductToken }) })
    await toAirtime(deps)
    const r = await hubtelRouter(req({ Message: "0" }), deps)
    expect(r.Message).toContain("What would you like to buy?")
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
    expect(deductToken).toHaveBeenCalledTimes(1)
  })
  it("a malformed number re-prompts and stays on the recipient step", async () => {
    const { deps, store } = shopDeps()
    await toAirtime(deps)
    const r = await hubtelRouter(req({ Message: "02441" }), deps)
    expect(r.Message).toBe("Invalid number.\nAma Data Hub\nBuy Airtime\nEnter recipient number:\n0. Back")
    expect(store.get("S1")?.step).toBe("SHOP_AIRTIME_ENTER_RECIPIENT")
  })
  it("detects MTN from a 233... recipient and asks the amount (decimal field)", async () => {
    const { deps, store } = shopDeps()
    await toAirtime(deps)
    const r = await hubtelRouter(req({ Message: "233244123456" }), deps)
    expect(r.Message).toBe("MTN Airtime\nEnter amount to pay\n(GHS 1 - 500):\n0. Back")
    expect(r.FieldType).toBe("decimal")
    expect(store.get("S1")).toMatchObject({ step: "SHOP_AIRTIME_ENTER_AMOUNT", airtimeRecipient: "0244123456", airtimeNetwork: "MTN" })
  })
  it("unknown prefix: network pick with real names; the pair is still prefix-validated", async () => {
    const { deps, store } = shopDeps()
    await toAirtime(deps)
    const menu = await hubtelRouter(req({ Message: "0230000000" }), deps)
    expect(menu.Message).toBe("Select recipient network:\n1. MTN\n2. Telecel\n3. AT\n0. Back")
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("Enter recipient number:")
    expect(store.get("S1")?.step).toBe("SHOP_AIRTIME_ENTER_RECIPIENT")
  })
  it("unknown prefix with validation off: the picked network is used", async () => {
    const { deps, store } = shopDeps({ getPrefixConfig: async () => ({ enabled: false, map: DEFAULT_NETWORK_PREFIXES }) })
    await toAirtime(deps)
    await hubtelRouter(req({ Message: "0230000000" }), deps)
    await hubtelRouter(req({ Message: "2" }), deps)
    expect(store.get("S1")).toMatchObject({ step: "SHOP_AIRTIME_ENTER_AMOUNT", airtimeRecipient: "0230000000", airtimeNetwork: "Telecel" })
  })
  it("network airtime disabled: re-prompts the recipient", async () => {
    const { deps, store } = shopDeps({ airtime: fakeAirtime({ isEnabled: async n => n !== "MTN" }) })
    await toAirtime(deps)
    const r = await hubtelRouter(req({ Message: "0244123456" }), deps)
    expect(r.Message).toContain("MTN airtime is unavailable.")
    expect(store.get("S1")?.step).toBe("SHOP_AIRTIME_ENTER_RECIPIENT")
  })
})

describe("shop airtime: amount and price", () => {
  for (const bad of ["0.5", "501", "abc", "10.555", "10abc", "-5", "", "1e1"]) {
    it(`rejects "${bad}"`, async () => {
      const { deps, store } = shopDeps()
      const r = await toConfirm(deps, "0244123456", bad)
      expect(r.Message).toContain("Enter a valid amount.")
      expect(store.get("S1")?.step).toBe("SHOP_AIRTIME_ENTER_AMOUNT")
    })
  }
  it("confirm uses the SHOP's fee rate (owner tier + markup): pay 10.00, they get 9.35", async () => {
    const airtimeFeeRate = vi.fn(async () => ({ totalFeeRate: 7, merchantCommissionRate: 2 }))
    const feeRate = vi.fn(async () => 5)
    const { deps, store } = shopDeps({ shop: fakeShop({ airtimeFeeRate }), airtime: fakeAirtime({ feeRate }) })
    const r = await toConfirm(deps)
    expect(airtimeFeeRate).toHaveBeenCalledWith("shop-1", "MTN")
    expect(feeRate).not.toHaveBeenCalled() // never the main-mode (caller's tier) rate
    expect(r.Message).toBe("Ama Data Hub\nMTN to 0244123456\nYou pay GHS 10.00\nThey get GHS 9.35\nfrom 0200585542\n1. Pay now\n2. Cancel")
    expect(store.get("S1")).toMatchObject({ step: "SHOP_AIRTIME_CONFIRM", airtimeAmount: 10, airtimeFee: 0.65, airtimeToDeliver: 9.35 })
  })
  it("a NaN shop fee rate fails closed on the amount screen", async () => {
    const { deps, store } = shopDeps({ shop: fakeShop({ airtimeFeeRate: async () => ({ totalFeeRate: NaN, merchantCommissionRate: NaN }) }) })
    const r = await toConfirm(deps)
    expect(r.Message).toContain("Enter a valid amount.")
    expect(store.get("S1")?.step).toBe("SHOP_AIRTIME_ENTER_AMOUNT")
  })
  it("'0' on the amount screen returns to the recipient step", async () => {
    const { deps, store } = shopDeps()
    await toAirtime(deps)
    await hubtelRouter(req({ Message: "0244123456" }), deps)
    const r = await hubtelRouter(req({ Message: "0" }), deps)
    expect(r.Message).toContain("Enter recipient number:")
    expect(store.get("S1")).toMatchObject({ step: "SHOP_AIRTIME_ENTER_RECIPIENT", airtimeRecipient: undefined, airtimeNetwork: undefined })
  })
})

describe("shop airtime: confirm -> AddToCart", () => {
  it("creates a shop airtime order with the shop's commission and returns AddToCart at what the caller pays", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps, store } = shopDeps({}, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "MTN Airtime to 0244123456", Qty: 1, Price: 10 })
    const row = sup.inserts["airtime_orders"][0]
    expect(row).toMatchObject({
      network: "MTN", beneficiary_phone: "0244123456", airtime_amount: 9.35, fee_amount: 0.65, total_paid: 10,
      pay_separately: false, status: "pending_payment", payment_status: "pending_payment",
      user_id: null, shop_id: "shop-1", merchant_commission: 0.19,
      customer_name: "USSD Customer", customer_email: null, dialing_phone: "+233200585542", channel: "ussd_shop",
    })
    expect(row.reference_code).toMatch(/^AT-/)
    expect(sup.inserts["hubtel_transactions"]).toHaveLength(1)
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({ order_table: "airtime_orders", order_id: NEW_ID, expected_amount: 10 })
    expect(store.get("S1")).toBeUndefined()
  })
  it("no shop token is deducted at confirm (billed once, at the code step)", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps } = shopDeps({ shop: fakeShop({ deductToken }) })
    await toConfirm(deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    expect(deductToken).toHaveBeenCalledTimes(1)
  })
  it("shop markup changed since the confirm screen: release, no order (review focus #7)", async () => {
    let markup = 2
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({ shop: fakeShop({ airtimeFeeRate: async () => ({ totalFeeRate: 5 + markup, merchantCommissionRate: markup }) }) }, sup)
    await toConfirm(deps)
    markup = 4
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toBe("Airtime rates changed. Please restart your order.")
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
    expect(sup.inserts["hubtel_transactions"]).toBeUndefined()
  })
  it("a NaN shop fee rate at confirm fails closed: release, no order", async () => {
    let rates = { totalFeeRate: 7, merchantCommissionRate: 2 }
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({ shop: fakeShop({ airtimeFeeRate: async () => rates }) }, sup)
    await toConfirm(deps)
    rates = { totalFeeRate: 7, merchantCommissionRate: NaN }
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toBe("Airtime rates changed. Please restart your order.")
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
  it("a session that lost airtimeToDeliver / airtimeAmount fails closed: release, no order", async () => {
    for (const lost of ["airtimeToDeliver", "airtimeAmount"] as const) {
      const sup = fakeSupabase({ pkg: OK_PKG })
      const { deps, store } = shopDeps({}, sup)
      await toConfirm(deps)
      const s = store.get("S1")!
      store.set("S1", { ...s, [lost]: undefined })
      const r = await hubtelRouter(req({ Message: "1" }), deps)
      expect(r.Type, lost).toBe("release")
      expect(sup.inserts["airtime_orders"], lost).toBeUndefined()
    }
  })
  it("limits lowered since the confirm screen: release, no order", async () => {
    let max = 500
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({ airtime: fakeAirtime({ getLimits: async () => ({ min: 1, max }) }) }, sup)
    await toConfirm(deps)
    max = 5
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("Amount must be GHS 1-5")
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
  it("network disabled since the confirm screen: release, no order", async () => {
    let on = true
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({ airtime: fakeAirtime({ isEnabled: async () => on }) }, sup)
    await toConfirm(deps)
    on = false
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toBe("MTN airtime is no longer available.")
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
  it("'2' cancels without an order", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps, store } = shopDeps({}, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "2" }), deps)
    expect(r).toMatchObject({ Type: "release", Message: "Order cancelled." })
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
    expect(store.get("S1")).toBeUndefined()
  })
})

describe("shop airtime: idempotent CONFIRM and replay", () => {
  it("a duplicate '1' creates ONE order and replays the same cart", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({}, sup)
    await toConfirm(deps)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    const second = await hubtelRouter(req({ Message: "1" }), deps)
    expect(second.Type).toBe("AddToCart")
    expect(second.Item).toEqual(first.Item)
    expect(sup.inserts["airtime_orders"]).toHaveLength(1)
    expect(sup.inserts["hubtel_transactions"]).toHaveLength(1)
  })
  it("tx insert hits a unique violation: orphan shop airtime order failed, winner's cart replayed", async () => {
    const sup = fakeSupabase({
      pkg: OK_PKG,
      txConflictRow: { order_table: "airtime_orders", order_id: "winner", expected_amount: 10, state: "awaiting_payment" },
      rows: { airtime_orders: { network: "MTN", beneficiary_phone: "0244123456" } },
    })
    const { deps } = shopDeps({}, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "MTN Airtime to 0244123456", Qty: 1, Price: 10 })
    expect(sup.updates).toContainEqual(expect.objectContaining({ table: "airtime_orders", patch: expect.objectContaining({ status: "failed", payment_status: "failed" }) }))
  })
  it("session expired after AddToCart: the next '1' replays the shop AIRTIME cart, not a new code prompt", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps, store } = shopDeps({}, sup)
    await toConfirm(deps)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    expect(store.get("S1")).toBeUndefined()
    const again = await hubtelRouter(req({ Message: "1" }), deps)
    expect(again.Type).toBe("AddToCart")
    expect(again.Item).toEqual(first.Item)
    expect(sup.inserts["airtime_orders"]).toHaveLength(1)
  })
})

describe("shop airtime: step isolation", () => {
  it("a shop-pinned session never runs a MAIN-mode airtime step (restarts in shop mode instead)", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps, store } = shopDeps({}, sup)
    store.set("S1", {
      mode: "shop", step: "AIRTIME_CONFIRM", dialingPhone: "+233200585542", platform: "USSD",
      airtimeRecipient: "0244123456", airtimeNetwork: "MTN", airtimeAmount: 10, airtimeFee: 0.48, airtimeToDeliver: 9.52,
    })
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toContain("Enter shop code:")
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
  it("a main-pinned session never runs a SHOP airtime step", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps, store } = makeDeps({}, sup)
    store.set("S1", {
      mode: "main", step: "SHOP_AIRTIME_CONFIRM", dialingPhone: "+233200585542", platform: "USSD", shopId: "shop-1",
      airtimeRecipient: "0244123456", airtimeNetwork: "MTN", airtimeAmount: 10, airtimeFee: 0.65, airtimeToDeliver: 9.35,
    })
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("response")
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
})
