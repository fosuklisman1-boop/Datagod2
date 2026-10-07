// lib/ussd-hubtel/flows/shop-data.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeShop, fakeSupabase, makeDeps, NEW_ID, OK_PKG, req, SHOP_CODE, SHOP_CONFIG } from "../testing/fakes"

async function toProduct(deps: RouterDeps) {
  await hubtelRouter(req({ Type: "Initiation" }), deps)
  return hubtelRouter(req({ Message: "1234" }), deps)
}
async function toNetworks(deps: RouterDeps) {
  const menu = await toProduct(deps)
  return hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Data Bundle") }), deps)
}
/** MTN (first shop network), first package, recipient -> confirm screen. */
async function toConfirm(deps: RouterDeps, recipient = "0244123456") {
  await toNetworks(deps)
  await hubtelRouter(req({ Message: "1" }), deps)
  await hubtelRouter(req({ Message: "1" }), deps)
  return hubtelRouter(req({ Message: recipient }), deps)
}
const shopDeps = (over: Parameters<typeof makeDeps>[0] = {}, sup = fakeSupabase({ pkg: OK_PKG })) =>
  makeDeps({ getConfig: SHOP_CONFIG, ...over }, sup)

describe("shop data: networks (review focus #4)", () => {
  it("lists only the shop's networks, real names, shop header", async () => {
    const { deps, store } = shopDeps({ shop: fakeShop({ networks: async () => ["AT-iShare", "MTN"] }) })
    const r = await toNetworks(deps)
    expect(r.Message).toBe("Ama Data Hub\nSelect Network:\n1. MTN\n2. AT iShare\n0. Back")
    expect(store.get("S1")?.step).toBe("SHOP_DATA_NETWORK")
  })
  it("a shop with no data packages: 'No packages available.' and stays on the product menu", async () => {
    const { deps, store } = shopDeps({ shop: fakeShop({ networks: async () => [] }) })
    const r = await toNetworks(deps)
    expect(r.Message).toContain("No packages available.\nAma Data Hub\nWhat would you like to buy?")
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
  })
  it("a network with no bundles: says so and stays on the network menu", async () => {
    const { deps, store } = shopDeps({ shop: fakeShop({ bundles: async () => [] }) })
    await toNetworks(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("No MTN packages available.")
    expect(store.get("S1")?.step).toBe("SHOP_DATA_NETWORK")
  })
  it("'0' on the network menu returns to the product menu without billing again (D5)", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps, store } = shopDeps({ shop: fakeShop({ deductToken }) })
    await toNetworks(deps)
    const r = await hubtelRouter(req({ Message: "0" }), deps)
    expect(r.Message).toContain("What would you like to buy?")
    expect(store.get("S1")).toMatchObject({ step: "SHOP_PRODUCT", shopId: "shop-1" })
    expect(deductToken).toHaveBeenCalledTimes(1)
  })
})

describe("shop data: packages and recipient", () => {
  it("shows shop prices and pages through them", async () => {
    const all = Array.from({ length: 7 }, (_, i) => ({ id: `pkg-${i + 1}`, size: String(i + 1), price: 10 + i }))
    const { deps, store } = shopDeps({ shop: fakeShop({ bundles: async () => all }) })
    await toNetworks(deps)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    expect(first.Message).toContain("1. 1GB - GHS 10.00")
    expect(first.Message).toContain("6. More...")
    const second = await hubtelRouter(req({ Message: "6" }), deps)
    expect(second.Message).toContain("7. 7GB - GHS 16.00")
    await hubtelRouter(req({ Message: "7" }), deps)
    expect(store.get("S1")).toMatchObject({ step: "SHOP_DATA_RECIPIENT", bundleId: "pkg-7", bundleSize: "7", bundlePrice: 16 })
  })
  it("rejects a recipient on another network (prefix validation on)", async () => {
    const { deps, store } = shopDeps()
    await toNetworks(deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    const r = await hubtelRouter(req({ Message: "0201234567" }), deps) // Telecel number for MTN data
    expect(r.Message).toContain("Enter recipient number")
    expect(store.get("S1")?.step).toBe("SHOP_DATA_RECIPIENT")
  })
  it("confirm shows the shop, bundle, recipient, shop price and payer", async () => {
    const { deps } = shopDeps()
    const r = await toConfirm(deps)
    expect(r.Message).toBe("Ama Data Hub\nConfirm order:\n5GB MTN\nTo: 0244123456\nGHS 12.00 from 0200585542\n1. Pay now\n2. Cancel")
  })
})

describe("shop data: confirm -> AddToCart", () => {
  it("creates the ussd_shop_orders row with the profit snapshot and returns AddToCart at the shop price", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps, store } = shopDeps({}, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "5GB MTN Plan", Qty: 1, Price: 12 })
    expect(sup.inserts["ussd_shop_orders"][0]).toEqual({
      shop_code_id: "code-1",
      shop_id: "shop-1",
      dialing_phone: "+233200585542",
      recipient_phone: "0244123456",
      network: "MTN",
      paystack_provider: "vod",
      package_id: "pkg-1",
      package_size: "5",
      amount: 12,
      shop_price: 12,
      profit_amount: 2,
      parent_shop_id: null,
      parent_profit_amount: 0,
      shop_name: "Ama Data Hub Ltd",
      customer_email: "0200585542@ussd.datagod.com",
      shop_owner_email: "owner@example.com",
      order_status: "pending",
      payment_status: "pending",
      channel: "ussd_shop",
    })
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({
      session_id: "S1", order_table: "ussd_shop_orders", order_id: NEW_ID, expected_amount: 12, platform: "USSD",
    })
    expect(store.has("S1")).toBe(false)
  })
  it("sub-agent shop: catalog and price verification use the parent; parent profit is snapshotted (review focus #4)", async () => {
    const bundles = vi.fn(async () => [{ id: "pkg-1", size: "5", price: 12 }])
    const verifyBundlePrice = vi.fn(async () => ({ verifiedPrice: 12, profitAmount: 1, parentProfitAmount: 1.5 }))
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({
      shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, parentShopId: "parent-1" }), bundles, verifyBundlePrice }),
    }, sup)
    await toConfirm(deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    expect(bundles).toHaveBeenCalledWith("shop-1", "MTN", "parent-1")
    expect(verifyBundlePrice).toHaveBeenCalledWith("shop-1", "pkg-1", "parent-1")
    expect(sup.inserts["ussd_shop_orders"][0]).toMatchObject({ parent_shop_id: "parent-1", profit_amount: 1, parent_profit_amount: 1.5, amount: 12 })
  })
  it("shop changed its margin since the confirm screen: release, no order (review focus #7)", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({ shop: fakeShop({ verifyBundlePrice: async () => ({ verifiedPrice: 13, profitAmount: 3, parentProfitAmount: 0 }) }) }, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toBe("Price changed to GHS 13.00. Please restart your order.")
    expect(sup.inserts["ussd_shop_orders"]).toBeUndefined()
  })
  it("a NaN verified price fails closed: release, no order", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({ shop: fakeShop({ verifyBundlePrice: async () => ({ verifiedPrice: NaN, profitAmount: 2, parentProfitAmount: 0 }) }) }, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).not.toContain("NaN")
    expect(sup.inserts["ussd_shop_orders"]).toBeUndefined()
  })
  it("an undefined/NaN profit snapshot fails closed: release, no order", async () => {
    for (const bad of [
      { verifiedPrice: 12, profitAmount: NaN, parentProfitAmount: 0 },
      { verifiedPrice: 12, profitAmount: 2, parentProfitAmount: undefined as unknown as number },
    ]) {
      const sup = fakeSupabase({ pkg: OK_PKG })
      const { deps } = shopDeps({ shop: fakeShop({ verifyBundlePrice: async () => bad }) }, sup)
      await toConfirm(deps)
      const r = await hubtelRouter(req({ Message: "1" }), deps)
      expect(r.Type).toBe("release")
      expect(sup.inserts["ussd_shop_orders"]).toBeUndefined()
    }
  })
  it("package withdrawn from the shop since the confirm screen: release, no order", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({ shop: fakeShop({ verifyBundlePrice: async () => null }) }, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toBe("Package no longer available. Please try again.")
    expect(sup.inserts["ussd_shop_orders"]).toBeUndefined()
  })
  it("'2' cancels without an order", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({}, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "2" }), deps)
    expect(r.Message).toBe("Order cancelled.")
    expect(sup.inserts["ussd_shop_orders"]).toBeUndefined()
  })
})

describe("shop data: idempotent CONFIRM and replay (review focus #3)", () => {
  const winner = { order_table: "ussd_shop_orders", order_id: "o-winner", expected_amount: 12, state: "awaiting_payment" }
  it("a duplicate '1' creates ONE order + ONE tx and replays the same AddToCart", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({}, sup)
    await toConfirm(deps)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    const second = await hubtelRouter(req({ Message: "1" }), deps)
    expect(second.Item).toEqual(first.Item)
    expect(sup.inserts["ussd_shop_orders"]).toHaveLength(1)
    expect(sup.inserts["hubtel_transactions"]).toHaveLength(1)
  })
  it("tx insert hits a unique violation: orphan shop order failed, winner's cart replayed", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG, txConflictRow: winner })
    const { deps } = shopDeps({}, sup)
    await toConfirm(deps)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "5GB MTN Plan", Qty: 1, Price: 12 })
    expect(sup.updates.some(u => u.table === "ussd_shop_orders" && u.patch.order_status === "failed" && u.patch.payment_status === "failed")).toBe(true)
  })
  for (const mode of ["shop", "main"] as const) {
    it(`session expired after AddToCart: the next '1' replays the SHOP cart (config now ${mode})`, async () => {
      const sup = fakeSupabase({ rows: { hubtel_transactions: { ...winner, order_id: "o1" }, ussd_shop_orders: { package_size: "2", network: "Telecel" } } })
      const { deps } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode, visibility: { data: true, afa: true, airtime: true, resultsChecker: true } }) }, sup)
      const r = await hubtelRouter(req({ Message: "1" }), deps)
      expect(r.Type).toBe("AddToCart")
      expect(r.Item).toEqual({ ItemName: "2GB Telecel Plan", Qty: 1, Price: 12 })
    })
  }
})
