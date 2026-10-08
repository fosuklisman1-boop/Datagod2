// lib/ussd-hubtel/flows/shop-rc.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeRc, fakeShop, fakeSupabase, makeDeps, NEW_ID, OK_PKG, req, SHOP_CODE, SHOP_CONFIG } from "../testing/fakes"

const shopDeps = (over: Parameters<typeof makeDeps>[0] = {}, sup = fakeSupabase({ pkg: OK_PKG })) =>
  makeDeps({ getConfig: SHOP_CONFIG, ...over }, sup)

async function toBoards(deps: RouterDeps) {
  await hubtelRouter(req({ Type: "Initiation" }), deps)
  const menu = await hubtelRouter(req({ Message: "1234" }), deps)
  return hubtelRouter(req({ Message: digitFor(menu.Message, "Results Checker") }), deps)
}
async function toConfirm(deps: RouterDeps, qty = "2") {
  await toBoards(deps)
  await hubtelRouter(req({ Message: "1" }), deps)
  return hubtelRouter(req({ Message: qty }), deps)
}

describe("shop vouchers: boards and quantity", () => {
  it("goes straight to the boards that are enabled AND in stock, under the shop header", async () => {
    const { deps, store } = shopDeps({ rc: fakeRc({ isBoardEnabled: async b => b !== "NOVDEC", availableCount: async b => (b === "BECE" ? 0 : 10) }) })
    const r = await toBoards(deps)
    expect(r.Message).toBe("Ama Data Hub\nSelect exam:\n1. WASSCE\n0. Back")
    expect(store.get("S1")).toMatchObject({ step: "SHOP_RC_SELECT_BOARD", rcBoardOptions: ["WASSCE"] })
  })
  it("every board sold out: 'Results Checker unavailable.' and stays on the product menu", async () => {
    const { deps, store } = shopDeps({ rc: fakeRc({ availableCount: async () => 0 }) })
    const r = await toBoards(deps)
    expect(r.Message).toContain("Results Checker unavailable.\nAma Data Hub\nWhat would you like to buy?")
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
  })
  it("'0' on the board list returns to the product menu", async () => {
    const { deps, store } = shopDeps()
    await toBoards(deps)
    await hubtelRouter(req({ Message: "0" }), deps)
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
  })
  it("'0' on the quantity screen re-reads the boards", async () => {
    let novdec = false
    const { deps, store } = shopDeps({ rc: fakeRc({ isBoardEnabled: async b => b !== "NOVDEC" || novdec }) })
    await toBoards(deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    novdec = true
    const r = await hubtelRouter(req({ Message: "0" }), deps)
    expect(r.Message).toBe("Ama Data Hub\nSelect exam:\n1. WASSCE\n2. BECE\n3. NOVDEC\n0. Back")
    expect(store.get("S1")).toMatchObject({ step: "SHOP_RC_SELECT_BOARD", rcBoardOptions: ["WASSCE", "BECE", "NOVDEC"] })
  })
  it("the shop name is sanitised to printable ASCII on every screen", async () => {
    const { deps } = shopDeps({ shop: fakeShop({ resolveCode: async c => (c === "1234" ? { ...SHOP_CODE, shopName: "Ama’s   Data Hub \u{1F600}" } : null) }) })
    const boards = await toBoards(deps)
    expect(boards.Message.split("\n")[0]).toBe("Amas Data Hub")
    await hubtelRouter(req({ Message: "1" }), deps)
    const confirm = await hubtelRouter(req({ Message: "2" }), deps)
    expect(confirm.Message.split("\n")[0]).toBe("Amas Data Hub")
    expect(confirm.Message).toMatch(/^[\x20-\x7E\n]*$/)
  })
  it("quantity screen shows the cap and the SHOP's bulk price at the threshold", async () => {
    const rcPrice = vi.fn(async (_b: string, q: number) => (q >= 5
      ? { unitPrice: 17, totalPaid: 17 * q, bulkApplied: true, merchantCommission: 2 * q }
      : { unitPrice: 22, totalPaid: 22 * q, bulkApplied: false, merchantCommission: 2 * q }))
    const { deps } = shopDeps({
      rc: fakeRc({ availableCount: async () => 8, bulkHint: async () => ({ minQty: 5, bulkBasePrice: 15 }) }),
      shop: fakeShop({ rcPrice }),
    })
    await toBoards(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toBe("WASSCE Checker\nHow many vouchers?\n(1 - 8):\nBuy 5+ for GHS 17.00 each\n0. Back")
    expect(rcPrice).toHaveBeenCalledWith("WASSCE", 5, "shop-1")
  })
  it("bulk confirm shows the shop's bulk unit rate", async () => {
    const rcPrice = async (_b: string, q: number) => (q >= 5
      ? { unitPrice: 17, totalPaid: 17 * q, bulkApplied: true, merchantCommission: 2 * q }
      : { unitPrice: 22, totalPaid: 22 * q, bulkApplied: false, merchantCommission: 2 * q })
    const { deps } = shopDeps({ shop: fakeShop({ rcPrice }) })
    const r = await toConfirm(deps, "5")
    expect(r.Message).toBe("Ama Data Hub\nWASSCE x 5\nBulk rate GHS 17.00 each\nGHS 85.00 from 0200585542\nPIN(s) sent by SMS\n1. Pay now\n2. Cancel")
  })
  for (const bad of ["11", "0.5", "abc", "-1"]) {
    it(`rejects quantity "${bad}"`, async () => {
      const { deps, store } = shopDeps()
      const r = await toConfirm(deps, bad)
      expect(r.Message).toContain("Enter a valid quantity.")
      expect(store.get("S1")?.step).toBe("SHOP_RC_ENTER_QTY")
    })
  }
  it("sold out between board and quantity: back to the product menu", async () => {
    let stock = 10
    const { deps, store } = shopDeps({ rc: fakeRc({ availableCount: async () => stock }) })
    await toBoards(deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    stock = 0
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("WASSCE vouchers are sold out.")
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
  })
  it("unusable shop price at the quantity step (NaN): no confirm screen, back to the product menu", async () => {
    const { deps, store } = shopDeps({ shop: fakeShop({ rcPrice: async () => ({ unitPrice: NaN, totalPaid: NaN, bulkApplied: false, merchantCommission: NaN }) }) })
    const r = await toConfirm(deps)
    expect(r.Message).toContain("Results Checker unavailable.")
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
  })
  it("confirm shows the shop, board x qty, shop total and payer", async () => {
    const { deps } = shopDeps()
    const r = await toConfirm(deps)
    expect(r.Message).toBe("Ama Data Hub\nWASSCE x 2\nGHS 44.00 from 0200585542\nPIN(s) sent by SMS\n1. Pay now\n2. Cancel")
  })
})

describe("shop vouchers: confirm -> AddToCart", () => {
  it("creates a shop RC order with the shop's commission; AddToCart at the shop total", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({}, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: expect.stringMatching(/^CH order [a-z0-9]+$/), Qty: 1, Price: 44 })
    const row = sup.inserts["results_checker_orders"][0]
    expect(row).toMatchObject({
      exam_board: "WASSCE", quantity: 2, customer_name: "USSD Customer", customer_email: null, customer_phone: "0200585542",
      unit_price: 22, fee_amount: 0, total_paid: 44, shop_id: "shop-1", merchant_commission: 4,
      status: "pending_payment", payment_status: "pending_payment", dialing_phone: "+233200585542", channel: "ussd_shop",
    })
    expect(row).not.toHaveProperty("user_id") // createShopRcOrder does not set it
    expect(row.reference_code).toMatch(/^RC-/)
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({ order_table: "results_checker_orders", order_id: NEW_ID, expected_amount: 44 })
  })
  it("no token is billed after the code step (one deduction for the whole purchase)", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps } = shopDeps({ shop: fakeShop({ deductToken }) })
    await toConfirm(deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    expect(deductToken).toHaveBeenCalledTimes(1)
  })
  it("'2' cancels: release, no order", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps, store } = shopDeps({}, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "2" }), deps)
    expect(r).toMatchObject({ Type: "release", Message: "Order cancelled." })
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
    expect(store.get("S1")).toBeUndefined()
  })
  it("shop markup changed since the confirm screen: release, no order (review focus #7, D11)", async () => {
    let unit = 22
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({ shop: fakeShop({ rcPrice: async (_b, q) => ({ unitPrice: unit, totalPaid: unit * q, bulkApplied: false, merchantCommission: 2 * q }) }) }, sup)
    await toConfirm(deps)
    unit = 25
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toBe("Price changed to GHS 50.00. Please restart your order.")
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
  })
  it("price unreadable (NaN) at '1': fails closed, release, no order", async () => {
    let broken = false
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({
      shop: fakeShop({ rcPrice: async (_b, q) => (broken
        ? { unitPrice: NaN, totalPaid: NaN, bulkApplied: false, merchantCommission: NaN }
        : { unitPrice: 22, totalPaid: 22 * q, bulkApplied: false, merchantCommission: 2 * q }) }),
    }, sup)
    await toConfirm(deps)
    broken = true
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toBe("Price changed. Please restart your order.")
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
  })
  it("same total but an unusable commission (NaN) at '1': fails closed, no order", async () => {
    let broken = false
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({
      shop: fakeShop({ rcPrice: async (_b, q) => ({ unitPrice: 22, totalPaid: 22 * q, bulkApplied: false, merchantCommission: broken ? NaN : 2 * q }) }),
    }, sup)
    await toConfirm(deps)
    broken = true
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
  })
  it("stock dropped below the quantity since the confirm screen: release, no order", async () => {
    let stock = 10
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({ rc: fakeRc({ availableCount: async () => stock }) }, sup)
    await toConfirm(deps)
    stock = 1
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("no longer available")
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
  })
  it("board switched off since the confirm screen: release, no order", async () => {
    let on = true
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({ rc: fakeRc({ isBoardEnabled: async () => on }) }, sup)
    await toConfirm(deps)
    on = false
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("no longer available")
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
  })
  it("a duplicate '1' creates ONE order and replays the same cart", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({}, sup)
    await toConfirm(deps)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    const second = await hubtelRouter(req({ Message: "1" }), deps)
    expect(second.Item).toEqual(first.Item)
    expect(sup.inserts["results_checker_orders"]).toHaveLength(1)
  })
  it("the voucher steps are shop-only: a main-mode session on SHOP_RC_CONFIRM restarts instead", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps, store } = makeDeps({}, sup)
    store.set("S1", { mode: "main", step: "SHOP_RC_CONFIRM", dialingPhone: "+233200585542", platform: "USSD", rcBoard: "WASSCE", rcQty: 2, rcTotal: 44 })
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("response")
    expect(store.get("S1")?.step).toBe("MAIN")
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
  })
})
