// lib/ussd-hubtel/flows/rc-buy.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeRc, fakeSupabase, makeDeps, NEW_ID, OK_PKG, req } from "../testing/fakes"

async function toRc(deps: RouterDeps) {
  const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
  return hubtelRouter(req({ Message: digitFor(menu.Message, "Results Checker") }), deps)
}
/** Results Checker -> Buy -> first board -> quantity -> confirm screen. */
async function toConfirm(deps: RouterDeps, qty = "2") {
  await toRc(deps)
  await hubtelRouter(req({ Message: "1" }), deps)
  await hubtelRouter(req({ Message: "1" }), deps)
  return hubtelRouter(req({ Message: qty }), deps)
}

describe("results checker: menus", () => {
  it("is on the main menu and opens the Results Checker menu", async () => {
    const { deps, store } = makeDeps()
    const r = await toRc(deps)
    expect(r.Message).toContain("1. Buy Vouchers")
    expect(r.Message).toContain("2. My Vouchers")
    expect(store.get("S1")?.step).toBe("RC_MENU")
  })
  it("is hidden when the admin turns it off", async () => {
    const { deps } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: false } }) })
    const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(menu.Message).not.toContain("Results Checker")
  })
  it("offers only boards that are enabled AND in stock", async () => {
    const { deps } = makeDeps({ rc: fakeRc({ isBoardEnabled: async b => b !== "NOVDEC", availableCount: async b => (b === "BECE" ? 0 : 10) }) })
    await toRc(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("1. WASSCE")
    expect(r.Message).not.toContain("BECE")
    expect(r.Message).not.toContain("NOVDEC")
  })
  it("says no vouchers when every board is sold out, and stays on the RC menu", async () => {
    const { deps, store } = makeDeps({ rc: fakeRc({ availableCount: async () => 0 }) })
    await toRc(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("No vouchers available right now.")
    expect(store.get("S1")?.step).toBe("RC_MENU")
  })
  it("'0' on the RC menu goes back to the main menu", async () => {
    const { deps, store } = makeDeps()
    await toRc(deps)
    await hubtelRouter(req({ Message: "0" }), deps)
    expect(store.get("S1")?.step).toBe("MAIN")
  })
})

describe("results checker: quantity", () => {
  it("shows the cap (min of stock and max) and the bulk hint", async () => {
    const { deps } = makeDeps({ rc: fakeRc({ availableCount: async () => 3, bulkHint: async () => ({ minQty: 5, bulkBasePrice: 15 }) }) })
    await toRc(deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("(1 - 3)")
    expect(r.Message).toContain("Buy 5+ for GHS 15.00 each")
  })
  for (const bad of ["4", "0.5", "abc", "-1"]) {
    it(`rejects quantity "${bad}" above stock or malformed`, async () => {
      const { deps, store } = makeDeps({ rc: fakeRc({ availableCount: async () => 3 }) })
      const r = await toConfirm(deps, bad)
      expect(r.Message).toContain("Enter a valid quantity.")
      expect(store.get("S1")?.step).toBe("RC_ENTER_QTY")
    })
  }
  it("sold out between the quantity prompt and the answer: back to the RC menu", async () => {
    let stock = 5
    const { deps, store } = makeDeps({ rc: fakeRc({ availableCount: async () => stock }) })
    await toRc(deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    stock = 0
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("sold out")
    expect(store.get("S1")?.step).toBe("RC_MENU")
  })
  it("confirm shows board x qty, total and payer; bulk rate when applied", async () => {
    const { deps } = makeDeps({ rc: fakeRc({ price: async (_b, q) => ({ unitPrice: 15, totalPaid: 15 * q, bulkApplied: true }) }) })
    const r = await toConfirm(deps, "5")
    expect(r.Message).toContain("WASSCE x 5")
    expect(r.Message).toContain("Bulk rate GHS 15.00 each")
    expect(r.Message).toContain("GHS 75.00 from 0200585542")
    expect(r.Message).toContain("1. Pay now\n2. Cancel")
  })
})

describe("results checker: confirm -> AddToCart", () => {
  it("creates the RC order + tx and returns AddToCart at the voucher total", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ resolveDialer: async () => ({ userId: "u1", email: "a@b.c" }) }, sup)
    await toConfirm(deps, "2")
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "WASSCE Checker x2", Qty: 1, Price: 40 })
    const row = sup.inserts["results_checker_orders"][0]
    expect(row).toMatchObject({
      exam_board: "WASSCE", quantity: 2, unit_price: 20, fee_amount: 0, total_paid: 40,
      customer_name: "USSD Customer", customer_email: "a@b.c", customer_phone: "0200585542",
      shop_id: null, merchant_commission: 0, user_id: "u1",
      status: "pending_payment", payment_status: "pending_payment", dialing_phone: "+233200585542", channel: "ussd",
    })
    expect(row.reference_code).toMatch(/^RC-/)
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({ order_table: "results_checker_orders", order_id: NEW_ID, expected_amount: 40 })
  })
  it("stock dropped below the quantity since the confirm screen: release, no order (review focus #2)", async () => {
    let stock = 10
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ rc: fakeRc({ availableCount: async () => stock }) }, sup)
    await toConfirm(deps, "2")
    stock = 1
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("no longer available")
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
  })
  it("stock dropped to exactly the quantity is still sellable", async () => {
    let stock = 10
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ rc: fakeRc({ availableCount: async () => stock }) }, sup)
    await toConfirm(deps, "2")
    stock = 2
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
  })
  it("board disabled since the confirm screen: release, no order", async () => {
    let on = true
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ rc: fakeRc({ isBoardEnabled: async () => on }) }, sup)
    await toConfirm(deps, "2")
    on = false
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
  })
  it("price changed since the confirm screen: release, no order", async () => {
    let unit = 20
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ rc: fakeRc({ price: async (_b, q) => ({ unitPrice: unit, totalPaid: unit * q, bulkApplied: false }) }) }, sup)
    await toConfirm(deps, "2")
    unit = 25
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("Price changed to GHS 50.00")
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
  })
  it("a NaN re-quoted total fails closed: release, no order", async () => {
    let bad = false
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ rc: fakeRc({ price: async (_b, q) => ({ unitPrice: 20, totalPaid: bad ? NaN : 20 * q, bulkApplied: false }) }) }, sup)
    await toConfirm(deps, "2")
    bad = true
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
    expect(sup.inserts["hubtel_transactions"]).toBeUndefined()
  })
  it("'2' on the confirm screen cancels with no order", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({}, sup)
    await toConfirm(deps, "2")
    const r = await hubtelRouter(req({ Message: "2" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("Order cancelled.")
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
  })
})

describe("results checker: idempotent CONFIRM (review focus #1)", () => {
  const winner = { order_table: "results_checker_orders", order_id: "o-winner", expected_amount: 40, state: "awaiting_payment" }
  it("a duplicate '1' creates ONE order + ONE tx and replays the same AddToCart", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({}, sup)
    await toConfirm(deps, "2")
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    const second = await hubtelRouter(req({ Message: "1" }), deps)
    expect(second.Item).toEqual(first.Item)
    expect(sup.inserts["results_checker_orders"]).toHaveLength(1)
    expect(sup.inserts["hubtel_transactions"]).toHaveLength(1)
  })
  it("tx insert hits a unique violation: orphan RC order failed, winner's cart replayed", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG, txConflictRow: winner })
    const { deps } = makeDeps({}, sup)
    await toConfirm(deps, "2")
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "WASSCE Checker x2", Qty: 1, Price: 40 })
    expect(sup.updates.some(u => u.table === "results_checker_orders" && u.patch.status === "failed" && u.patch.payment_status === "failed")).toBe(true)
  })
})

describe("results checker: my vouchers", () => {
  const order = { id: "v1", exam_board: "WASSCE", reference_code: "RC-AAA-BBB", created_at: "2026-10-05T10:00:00Z" }
  it("lists the caller's vouchers, opens one and resends it by SMS", async () => {
    const resendVouchers = vi.fn(async () => ({ success: true, message: "ok" }))
    const { deps } = makeDeps({ rc: fakeRc({ listMyVouchers: async () => [order], resendVouchers }) })
    await toRc(deps)
    const list = await hubtelRouter(req({ Message: "2" }), deps)
    expect(list.Message).toContain("1. WASSCE RC-AAA-BBB (5 Oct)")
    const detail = await hubtelRouter(req({ Message: "1" }), deps)
    expect(detail.Message).toContain("1. Resend SMS")
    const done = await hubtelRouter(req({ Message: "1" }), deps)
    expect(resendVouchers).toHaveBeenCalledWith("v1")
    expect(done.Type).toBe("release")
    expect(done.Message).toContain("resent by SMS")
  })
  it("says so when there are no vouchers", async () => {
    const { deps } = makeDeps()
    await toRc(deps)
    const r = await hubtelRouter(req({ Message: "2" }), deps)
    expect(r.Message).toContain("No completed vouchers")
  })
  it("a failed or throwing resend releases with a safe message", async () => {
    const { deps } = makeDeps({ rc: fakeRc({ listMyVouchers: async () => [order], resendVouchers: async () => { throw new Error("db down") } }) })
    await toRc(deps)
    await hubtelRouter(req({ Message: "2" }), deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("Resend failed")
  })
})
