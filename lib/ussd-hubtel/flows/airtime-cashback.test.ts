// lib/ussd-hubtel/flows/airtime-cashback.test.ts
// Commission cashback on Hubtel USSD airtime (main + shop). Review focus #1: with cashback not
// applied, every screen, the cart price and the inserted airtime_orders row are byte-identical to the
// pre-cashback flow (golden literals below were captured from the flows before cashback was wired in).
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { USSD_SCREEN_LIMIT } from "../protocol"
import type { StorefrontQuote } from "@/lib/cashback/quote"
import { digitFor, fakeAirtime, fakeSupabase, makeDeps, NEW_ID, OK_PKG, req, SHOP_CONFIG } from "../testing/fakes"
import { cashbackAirtimeConfirmText } from "./airtime-cashback"

const quote = (over: Partial<StorefrontQuote> = {}): StorefrontQuote => ({
  applied: true, faceAmount: 10, rate: 4, share: 40, commission: 0.4, customerCashback: 0.16, shopShare: 0,
  payAmount: 9.84, datagodKeeps: 0.24, provider: "hubtel", base: 9.84, paymentFee: 0, feeRate: 0, ...over,
})
const SHOP_QUOTE = quote({ share: 50, customerCashback: 0.2, shopShare: 0.1, payAmount: 9.8, base: 9.8, datagodKeeps: 0.1 })

/** Every screen of a full main-mode airtime run, the cart, and the inserted row. */
async function mainRun(deps: RouterDeps, sup: ReturnType<typeof fakeSupabase>, amount = "10", junk = false) {
  const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
  const recipient = await hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Airtime") }), deps)
  const amountScreen = await hubtelRouter(req({ Message: "0244123456" }), deps)
  const confirm = await hubtelRouter(req({ Message: amount }), deps)
  const repaint = junk ? await hubtelRouter(req({ Message: "9" }), deps) : null
  const cart = await hubtelRouter(req({ Message: "1" }), deps)
  return { screens: [recipient.Message, amountScreen.Message, confirm.Message], repaint: repaint?.Message, cart, row: sup.inserts["airtime_orders"]?.[0], tx: sup.inserts["hubtel_transactions"]?.[0] }
}
async function shopRun(deps: RouterDeps, sup: ReturnType<typeof fakeSupabase>, amount = "10", junk = false) {
  await hubtelRouter(req({ Type: "Initiation" }), deps)
  const menu = await hubtelRouter(req({ Message: "1234" }), deps)
  const recipient = await hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Airtime") }), deps)
  const amountScreen = await hubtelRouter(req({ Message: "0244123456" }), deps)
  const confirm = await hubtelRouter(req({ Message: amount }), deps)
  const repaint = junk ? await hubtelRouter(req({ Message: "9" }), deps) : null
  const cart = await hubtelRouter(req({ Message: "1" }), deps)
  return { screens: [recipient.Message, amountScreen.Message, confirm.Message], repaint: repaint?.Message, cart, row: sup.inserts["airtime_orders"]?.[0], tx: sup.inserts["hubtel_transactions"]?.[0] }
}

const CART = (price: number) => ({ ItemName: expect.stringMatching(/^CH order [a-z0-9]+$/), Qty: 1, Price: price })

describe("main airtime: cashback NOT applied is byte-identical (review focus #1)", () => {
  const LEGACY_SCREENS = [
    "Buy Airtime\nEnter recipient number\n(who gets the airtime):\n0. Back",
    "MTN Airtime\nEnter amount to pay\n(GHS 1 - 500):\n0. Back",
    "Confirm Airtime\nMTN to 0244123456\nYou pay GHS 10.00\nThey get GHS 9.52\nfrom 0200585542\n1. Pay now\n2. Cancel",
  ]
  const LEGACY_ROW = {
    reference_code: expect.stringMatching(/^AT-/),
    network: "MTN", beneficiary_phone: "0244123456", airtime_amount: 9.52, fee_amount: 0.48, total_paid: 10,
    pay_separately: false, status: "pending_payment", payment_status: "pending_payment",
    user_id: "u1", shop_id: null, merchant_commission: 0, customer_name: "USSD Customer", customer_email: "a@b.c",
    dialing_phone: "+233200585542", channel: "ussd",
  }
  it("screens, repaint, cart price and the exact row (no extra columns)", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const cashbackQuote = vi.fn(async () => null)
    const { deps } = makeDeps({ airtime: fakeAirtime({ cashbackQuote }), resolveDialer: async () => ({ userId: "u1", email: "a@b.c" }) }, sup)
    const r = await mainRun(deps, sup, "10", true)
    expect(r.screens).toStrictEqual(LEGACY_SCREENS)
    expect(r.repaint).toBe(LEGACY_SCREENS[2])
    expect(r.cart.Type).toBe("AddToCart")
    expect(r.cart.Item).toEqual(CART(10))
    expect(r.row).toStrictEqual(LEGACY_ROW)
    expect(r.tx).toMatchObject({ order_table: "airtime_orders", order_id: NEW_ID, expected_amount: 10 })
    expect(cashbackQuote).toHaveBeenCalledWith("MTN", 10, false)
  })
})

describe("shop airtime: cashback NOT applied is byte-identical (review focus #1)", () => {
  const LEGACY_SCREENS = [
    "Ama Data Hub\nBuy Airtime\nEnter recipient number:\n0. Back",
    "MTN Airtime\nEnter amount to pay\n(GHS 1 - 500):\n0. Back",
    "Ama Data Hub\nMTN to 0244123456\nYou pay GHS 10.00\nThey get GHS 9.35\nfrom 0200585542\n1. Pay now\n2. Cancel",
  ]
  const LEGACY_ROW = {
    reference_code: expect.stringMatching(/^AT-/),
    network: "MTN", beneficiary_phone: "0244123456", airtime_amount: 9.35, fee_amount: 0.65, total_paid: 10,
    pay_separately: false, status: "pending_payment", payment_status: "pending_payment",
    user_id: null, shop_id: "shop-1", merchant_commission: 0.19,
    customer_name: "USSD Customer", customer_email: null, dialing_phone: "+233200585542", channel: "ussd_shop",
  }
  it("screens, repaint, cart price and the exact row (no extra columns)", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const cashbackQuote = vi.fn(async () => null)
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG, airtime: fakeAirtime({ cashbackQuote }) }, sup)
    const r = await shopRun(deps, sup, "10", true)
    expect(r.screens).toStrictEqual(LEGACY_SCREENS)
    expect(r.repaint).toBe(LEGACY_SCREENS[2])
    expect(r.cart.Item).toEqual(CART(10))
    expect(r.row).toStrictEqual(LEGACY_ROW)
    expect(r.tx).toMatchObject({ order_table: "airtime_orders", order_id: NEW_ID, expected_amount: 10 })
    expect(cashbackQuote).toHaveBeenCalledWith("MTN", 10, true)
  })
})

describe("cashbackAirtimeConfirmText", () => {
  it("Pay x (was face) + You receive face <network> airtime", () => {
    expect(cashbackAirtimeConfirmText("Confirm Airtime", "MTN", "0244123456", 9.84, 10, "0200585542")).toBe(
      "Confirm Airtime\nMTN to 0244123456\nPay GHS 9.84 (was GHS 10.00)\nYou receive GHS 10.00 MTN airtime\nfrom 0200585542\n1. Pay now\n2. Cancel",
    )
  })
  it("no '(was ...)' when the caller does not pay less than face (payment fee >= cashback)", () => {
    expect(cashbackAirtimeConfirmText("Confirm Airtime", "MTN", "0244123456", 10, 10, "0200585542")).not.toContain("was")
  })
  it("worst case fits the 182-char USSD screen and never mentions data/bundle", () => {
    const t = cashbackAirtimeConfirmText("X".repeat(30), "AirtelTigo", "0244123456", 99999.98, 99999.99, "0244123456")
    expect(t.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
    expect(t).not.toMatch(/data|bundle/i)
    expect(t.endsWith("1. Pay now\n2. Cancel")).toBe(true)
  })
})

describe("main airtime: cashback applied", () => {
  const applied = (q = quote()) => vi.fn(async () => q)
  it("confirm shows the cashback price; cart = payAmount; row = face, fee 0, snapshot, no shop share", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const feeRate = vi.fn(async () => 5)
    const { deps, store } = makeDeps({ airtime: fakeAirtime({ cashbackQuote: applied(), feeRate }), resolveDialer: async () => ({ userId: "u1", email: "a@b.c", role: "dealer" }) }, sup)
    const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
    await hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Airtime") }), deps)
    await hubtelRouter(req({ Message: "0244123456" }), deps)
    const confirm = await hubtelRouter(req({ Message: "10" }), deps)
    expect(confirm.Message).toBe("Confirm Airtime\nMTN to 0244123456\nPay GHS 9.84 (was GHS 10.00)\nYou receive GHS 10.00 MTN airtime\nfrom 0200585542\n1. Pay now\n2. Cancel")
    expect(store.get("S1")).toMatchObject({ step: "AIRTIME_CONFIRM", airtimeAmount: 10, airtimeFee: 0, airtimeToDeliver: 10, airtimeCashbackPay: 9.84 })
    const repaint = await hubtelRouter(req({ Message: "7" }), deps)
    expect(repaint.Message).toBe(confirm.Message)
    const cart = await hubtelRouter(req({ Message: "1" }), deps)
    expect(cart.Type).toBe("AddToCart")
    expect(cart.Item).toEqual(CART(9.84))
    expect(cart.Item!.ItemName).not.toMatch(/airtime|data|bundle/i)
    expect(sup.inserts["airtime_orders"][0]).toStrictEqual({
      reference_code: expect.stringMatching(/^AT-/),
      network: "MTN", beneficiary_phone: "0244123456", airtime_amount: 10, fee_amount: 0, total_paid: 9.84,
      pay_separately: false, status: "pending_payment", payment_status: "pending_payment",
      user_id: "u1", shop_id: null, merchant_commission: 0, customer_name: "USSD Customer", customer_email: "a@b.c",
      dialing_phone: "+233200585542", channel: "ussd",
      payment_fee_amount: 0, cashback_amount: 0.16, shop_share_amount: 0, cashback_rate: 4, cashback_share: 40,
      cashback_provider: "hubtel", expected_commission: 0.4,
    })
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({ order_table: "airtime_orders", order_id: NEW_ID, expected_amount: 9.84 })
    expect(feeRate).not.toHaveBeenCalled() // the legacy dealer fee never applies when cashback prices the order
  })
  it("payment fee is snapshotted and included in the price", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const q = quote({ paymentFee: 0.1, feeRate: 1, payAmount: 9.94 })
    const { deps } = makeDeps({ airtime: fakeAirtime({ cashbackQuote: applied(q) }), resolveDialer: async () => ({ userId: "u1" }) }, sup)
    const r = await mainRun(deps, sup)
    expect(r.screens[2]).toContain("Pay GHS 9.94 (was GHS 10.00)")
    expect(r.cart.Item).toEqual(CART(9.94))
    expect(r.row).toMatchObject({ total_paid: 9.94, payment_fee_amount: 0.1 })
  })
  it("cashback switched OFF after the confirm screen: release, no order (never a silent re-price)", async () => {
    let q: StorefrontQuote | null = quote()
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ airtime: fakeAirtime({ cashbackQuote: async () => q }) }, sup)
    const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
    await hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Airtime") }), deps)
    await hubtelRouter(req({ Message: "0244123456" }), deps)
    await hubtelRouter(req({ Message: "10" }), deps)
    q = null
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r).toMatchObject({ Type: "release", Message: "Airtime rates changed. Please restart your order." })
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
  it("cashback switched ON after a legacy confirm screen: release, no order", async () => {
    let q: StorefrontQuote | null = null
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ airtime: fakeAirtime({ cashbackQuote: async () => q }) }, sup)
    const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
    await hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Airtime") }), deps)
    await hubtelRouter(req({ Message: "0244123456" }), deps)
    await hubtelRouter(req({ Message: "10" }), deps)
    q = quote()
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toBe("Airtime rates changed. Please restart your order.")
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
  it("cashback price changed since the screen: release, no order", async () => {
    let q = quote()
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ airtime: fakeAirtime({ cashbackQuote: async () => q }) }, sup)
    const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
    await hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Airtime") }), deps)
    await hubtelRouter(req({ Message: "0244123456" }), deps)
    await hubtelRouter(req({ Message: "10" }), deps)
    q = quote({ payAmount: 9.9 })
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toBe("Airtime rates changed. Please restart your order.")
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
  it("an unusable quote (NaN price / wrong face) falls back to legacy pricing", async () => {
    for (const bad of [quote({ payAmount: NaN }), quote({ faceAmount: 20 }), quote({ applied: false })]) {
      const sup = fakeSupabase({ pkg: OK_PKG })
      const { deps } = makeDeps({ airtime: fakeAirtime({ cashbackQuote: async () => bad }), resolveDialer: async () => ({ userId: "u1", email: "a@b.c" }) }, sup)
      const r = await mainRun(deps, sup)
      expect(r.screens[2]).toContain("They get GHS 9.52")
      expect(r.row).toMatchObject({ airtime_amount: 9.52, fee_amount: 0.48, total_paid: 10 })
      expect(r.row).not.toHaveProperty("cashback_amount")
    }
  })
})

describe("shop airtime: cashback applied", () => {
  it("shop split: price = payAmount, merchant_commission = the shop's cashback share (not the markup)", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const cashbackQuote = vi.fn(async () => SHOP_QUOTE)
    const airtimeFeeRate = vi.fn(async () => ({ totalFeeRate: 7, merchantCommissionRate: 2 }))
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, airtime: fakeAirtime({ cashbackQuote }) }, sup)
    deps.shop = { ...deps.shop, airtimeFeeRate }
    const r = await shopRun(deps, sup, "10", true)
    expect(cashbackQuote).toHaveBeenCalledWith("MTN", 10, true)
    expect(r.screens[2]).toBe("Ama Data Hub\nMTN to 0244123456\nPay GHS 9.80 (was GHS 10.00)\nYou receive GHS 10.00 MTN airtime\nfrom 0200585542\n1. Pay now\n2. Cancel")
    expect(r.repaint).toBe(r.screens[2])
    expect(r.cart.Item).toEqual(CART(9.8))
    expect(r.row).toStrictEqual({
      reference_code: expect.stringMatching(/^AT-/),
      network: "MTN", beneficiary_phone: "0244123456", airtime_amount: 10, fee_amount: 0, total_paid: 9.8,
      pay_separately: false, status: "pending_payment", payment_status: "pending_payment",
      user_id: null, shop_id: "shop-1", merchant_commission: 0.1,
      customer_name: "USSD Customer", customer_email: null, dialing_phone: "+233200585542", channel: "ussd_shop",
      payment_fee_amount: 0, cashback_amount: 0.2, shop_share_amount: 0.1, cashback_rate: 4, cashback_share: 50,
      cashback_provider: "hubtel", expected_commission: 0.4,
    })
    expect(r.tx).toMatchObject({ expected_amount: 9.8 })
    expect(airtimeFeeRate).not.toHaveBeenCalled()
    expect(store.get("S1")).toBeUndefined()
  })
  it("cashback switched off after the confirm screen: release, no order", async () => {
    let q: StorefrontQuote | null = SHOP_QUOTE
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG, airtime: fakeAirtime({ cashbackQuote: async () => q }) }, sup)
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    const menu = await hubtelRouter(req({ Message: "1234" }), deps)
    await hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Airtime") }), deps)
    await hubtelRouter(req({ Message: "0244123456" }), deps)
    await hubtelRouter(req({ Message: "10" }), deps)
    q = null
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r).toMatchObject({ Type: "release", Message: "Airtime rates changed. Please restart your order." })
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
})
