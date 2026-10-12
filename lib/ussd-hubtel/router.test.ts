// lib/ussd-hubtel/router.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, MAIN_MENU_ENTRIES, SHOP_PRODUCT_ENTRIES, type RouterDeps } from "./router"
import { IMPLEMENTED_SERVICES, type MainMenuKey } from "./menus"
import { getHubtelUssdConfig } from "./config"
import { digitFor, fakeShop, fakeSupabase, makeDeps, req } from "./testing/fakes"

describe("hubtelRouter: entry guards", () => {
  it("releases when the channel is disabled", async () => {
    const { deps } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: false, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } }) })
    const r = await hubtelRouter(req({ Type: "Initiation", Message: "*713#" }), deps)
    expect(r.Type).toBe("release")
  })
  it("shop mode answers Initiation with the shop-code prompt", async () => {
    const { deps } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "shop", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } }) })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toContain("Enter shop code:")
  })
  it("releases a shop-mode Initiation when the channel is disabled", async () => {
    const { deps, store } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: false, mode: "shop", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } }) })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Type).toBe("release")
    expect(store.has("S1")).toBe(false)
  })
  it("Timeout deletes the session", async () => {
    const { deps, store } = makeDeps()
    store.set("S1", { step: "MAIN", dialingPhone: "+233200585542", platform: "USSD" })
    const r = await hubtelRouter(req({ Type: "Timeout" }), deps)
    expect(r.Type).toBe("release")
    expect(store.has("S1")).toBe(false)
  })
})

describe("hubtelRouter: initiation and recovery", () => {
  it("shows the main menu and stores a MAIN session with E.164 phone", async () => {
    const { deps, store } = makeDeps()
    const r = await hubtelRouter(req({ Type: "Initiation", Message: "*713#" }), deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toContain("1. Buy Data Bundle")
    expect(r.ClientState).toBe("MAIN")
    expect(store.get("S1")).toMatchObject({ step: "MAIN", dialingPhone: "+233200585542", platform: "USSD" })
  })
  it("releases politely when no service is available to this caller", async () => {
    const { deps } = makeDeps({
      isDataBlocked: async () => true,
      getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "main", visibility: { data: true, afa: false, airtime: false, resultsChecker: false } }),
    })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toMatch(/no services/i)
  })
  it("Redis miss mid-flow restarts with 'Session expired' and the menu (review focus #2)", async () => {
    const { deps } = makeDeps()
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toContain("Session expired.")
    expect(r.Message).toContain("Buy Data Bundle")
  })
})

async function walkTo(step: "SELECT_BUNDLE" | "ENTER_RECIPIENT" | "CONFIRM", deps: RouterDeps) {
  await hubtelRouter(req({ Type: "Initiation" }), deps)
  await hubtelRouter(req({ Message: "1" }), deps) // data
  await hubtelRouter(req({ Message: "1" }), deps) // MTN
  if (step === "SELECT_BUNDLE") return
  await hubtelRouter(req({ Message: "1" }), deps) // first bundle
  if (step === "ENTER_RECIPIENT") return
  await hubtelRouter(req({ Message: "0244123456" }), deps)
}

describe("hubtelRouter: bad input keeps the session (review focus #5)", () => {
  it("re-shows the main menu on an out-of-range digit and on letters", async () => {
    const { deps, store } = makeDeps()
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    for (const bad of ["9", "abc"]) {
      const r = await hubtelRouter(req({ Message: bad }), deps)
      expect(r.Message).toContain("Buy Data Bundle")
      expect(store.get("S1")?.step).toBe("MAIN")
    }
  })
  it("rejects a malformed recipient and stays on ENTER_RECIPIENT with a phone field", async () => {
    const { deps, store } = makeDeps()
    await walkTo("ENTER_RECIPIENT", deps)
    const r = await hubtelRouter(req({ Message: "12345" }), deps)
    expect(r.Message).toMatch(/invalid/i)
    expect(r.FieldType).toBe("phone")
    expect(store.get("S1")?.step).toBe("ENTER_RECIPIENT")
  })
  it("rejects a wrong-network recipient (prefix validation)", async () => {
    const { deps, store } = makeDeps()
    await walkTo("ENTER_RECIPIENT", deps)
    const r = await hubtelRouter(req({ Message: "0200000000" }), deps) // Telecel number for an MTN bundle
    expect(store.get("S1")?.step).toBe("ENTER_RECIPIENT")
    expect(r.Type).toBe("response")
    expect(r.Message).toContain("looks like a Telecel number")
  })
  it("accepts 233â€¦ and +233â€¦ recipient formats, normalised to local", async () => {
    const { deps, store } = makeDeps()
    await walkTo("ENTER_RECIPIENT", deps)
    await hubtelRouter(req({ Message: "233244123456" }), deps)
    expect(store.get("S1")).toMatchObject({ step: "CONFIRM", recipientPhone: "0244123456" })
  })
  it("normalises a +233â€¦ recipient to local", async () => {
    const { deps, store } = makeDeps()
    await walkTo("ENTER_RECIPIENT", deps)
    await hubtelRouter(req({ Message: "+233244123456" }), deps)
    expect(store.get("S1")).toMatchObject({ step: "CONFIRM", recipientPhone: "0244123456" })
  })
})

describe("hubtelRouter: confirm â†’ AddToCart", () => {
  it("creates the order + hubtel_transactions and returns AddToCart at our price", async () => {
    const sup = fakeSupabase({ pkg: { price: 10, dealer_price: null, is_available: true } })
    const { deps, store } = makeDeps({}, sup)
    await walkTo("CONFIRM", deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: expect.stringMatching(/^CH order [a-z0-9]+$/), Qty: 1, Price: 10 })
    expect(sup.inserts["ussd_orders"][0]).toMatchObject({
      dialing_phone: "+233200585542", recipient_phone: "0244123456", network: "MTN",
      package_id: "pkg-1", amount: 10, order_status: "pending", payment_status: "pending",
    })
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({
      session_id: "S1", order_table: "ussd_orders", order_id: "11111111-1111-1111-1111-111111111111",
      expected_amount: 10, platform: "USSD",
    })
    expect(store.has("S1")).toBe(false)
  })
  it("cancels without creating an order", async () => {
    const sup = fakeSupabase({ pkg: { price: 10, dealer_price: null, is_available: true } })
    const { deps } = makeDeps({}, sup)
    await walkTo("CONFIRM", deps)
    const r = await hubtelRouter(req({ Message: "2" }), deps)
    expect(r.Type).toBe("release")
    expect(sup.inserts["ussd_orders"]).toBeUndefined()
  })
  it("refuses when the price changed since the menu was shown", async () => {
    const sup = fakeSupabase({ pkg: { price: 12, dealer_price: null, is_available: true } })
    const { deps } = makeDeps({}, sup)
    await walkTo("CONFIRM", deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toMatch(/price changed/i)
    expect(sup.inserts["ussd_orders"]).toBeUndefined()
  })
  it("marks the order failed and releases if hubtel_transactions cannot be written", async () => {
    const sup = fakeSupabase({ pkg: { price: 10, dealer_price: null, is_available: true }, txError: true })
    const { deps } = makeDeps({}, sup)
    await walkTo("CONFIRM", deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Type).not.toBe("AddToCart")
    expect(sup.updates.some(u => u.table === "ussd_orders" && u.patch.order_status === "failed" && u.patch.payment_status === "failed")).toBe(true)
  })
})

describe("hubtelRouter: idempotent CONFIRM", () => {
  const okPkg = { price: 10, dealer_price: null, is_available: true }
  it("a duplicate '1' creates ONE order + ONE tx and replays the same AddToCart", async () => {
    const sup = fakeSupabase({ pkg: okPkg })
    const { deps } = makeDeps({}, sup)
    await walkTo("CONFIRM", deps)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    const second = await hubtelRouter(req({ Message: "1" }), deps)
    expect(first.Type).toBe("AddToCart")
    expect(second.Type).toBe("AddToCart")
    expect(second.Item).toEqual(first.Item)
    expect(sup.inserts["ussd_orders"]).toHaveLength(1)
    expect(sup.inserts["hubtel_transactions"]).toHaveLength(1)
  })
  it("a concurrent duplicate while the session still exists replays instead of inserting", async () => {
    const sup = fakeSupabase({
      pkg: okPkg,
      txRow: { order_table: "ussd_orders", order_id: "o1", expected_amount: 10, state: "awaiting_payment" },
      orderRow: { package_size: "5", network: "MTN" },
    })
    const { deps } = makeDeps({}, sup)
    await walkTo("CONFIRM", deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: expect.stringMatching(/^CH order [a-z0-9]+$/), Qty: 1, Price: 10 })
    expect(sup.inserts["ussd_orders"]).toBeUndefined()
    expect(sup.inserts["hubtel_transactions"]).toBeUndefined()
  })
  it("(M2) tx insert hits a unique violation (concurrent CONFIRM won): orphan order failed, replays AddToCart", async () => {
    const sup = fakeSupabase({
      pkg: okPkg,
      txConflictRow: { order_table: "ussd_orders", order_id: "o-winner", expected_amount: 10, state: "awaiting_payment" },
      orderRow: { package_size: "5", network: "MTN" },
    })
    const { deps } = makeDeps({}, sup)
    await walkTo("CONFIRM", deps)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: expect.stringMatching(/^CH order [a-z0-9]+$/), Qty: 1, Price: 10 })
    expect(sup.updates.some(u => u.table === "ussd_orders" && u.patch.order_status === "failed")).toBe(true)
  })

  it("no session but an awaiting_payment tx exists: replays AddToCart, not the menu", async () => {
    const sup = fakeSupabase({
      txRow: { order_table: "ussd_orders", order_id: "o1", expected_amount: 10, state: "awaiting_payment" },
      orderRow: { package_size: "5", network: "MTN" },
    })
    const { deps } = makeDeps({}, sup)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: expect.stringMatching(/^CH order [a-z0-9]+$/), Qty: 1, Price: 10 })
    expect(r.Message).not.toContain("Buy Data Bundle")
  })
  it("an existing tx in another state releases 'already submitted'", async () => {
    const sup = fakeSupabase({
      txRow: { order_table: "ussd_orders", order_id: "o1", expected_amount: 10, state: "fulfilled" },
    })
    const { deps } = makeDeps({}, sup)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("already submitted")
  })
})

describe("hubtelRouter: back navigation and pagination", () => {
  it("'0' at SELECT_BUNDLE returns the network menu", async () => {
    const { deps, store } = makeDeps()
    await walkTo("SELECT_BUNDLE", deps)
    const r = await hubtelRouter(req({ Message: "0" }), deps)
    expect(r.Message).toContain("MTN")
    expect(store.get("S1")?.step).toBe("SELECT_NETWORK")
  })
  it("'0' at ENTER_RECIPIENT returns the bundle menu", async () => {
    const { deps, store } = makeDeps()
    await walkTo("ENTER_RECIPIENT", deps)
    const r = await hubtelRouter(req({ Message: "0" }), deps)
    expect(r.Message).toContain("Select Package")
    expect(store.get("S1")?.step).toBe("SELECT_BUNDLE")
  })
  it("pages through bundles: 'More' shows page 2 numbering and '7' picks its 2nd bundle", async () => {
    const all = Array.from({ length: 12 }, (_, i) => ({ id: `p${i + 1}`, size: String(i + 1), price: 10 }))
    const { deps, store } = makeDeps({
      fetchBundles: async (_n, page) => ({ bundles: all.slice(page * 5, page * 5 + 5), total: 12 }),
    })
    await walkTo("SELECT_BUNDLE", deps)
    const more = await hubtelRouter(req({ Message: "6" }), deps)
    expect(more.Message).toContain("6. 6GB")
    expect(store.get("S1")?.bundlePage).toBe(1)
    await hubtelRouter(req({ Message: "7" }), deps)
    expect(store.get("S1")).toMatchObject({ step: "ENTER_RECIPIENT", bundleId: "p7" })
  })
})

describe("hubtelRouter: other platforms", () => {
  const long = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, size: "x".repeat(40), price: 99.99 }))
  async function bundleScreen(platform: "USSD" | "Webstore", sessionId: string) {
    const { deps } = makeDeps({ fetchBundles: async () => ({ bundles: long, total: 5 }) })
    await hubtelRouter(req({ Type: "Initiation", SessionId: sessionId, Platform: platform }), deps)
    await hubtelRouter(req({ Message: "1", SessionId: sessionId, Platform: platform }), deps)
    return hubtelRouter(req({ Message: "1", SessionId: sessionId, Platform: platform }), deps)
  }
  it("truncates the long bundle menu on USSD to 182 chars ending in '...'", async () => {
    const r = await bundleScreen("USSD", "SU")
    expect(r.Message.endsWith("...")).toBe(true)
    expect(r.Message.length).toBe(182)
  })
  it("serves Webstore without truncating the same long menu", async () => {
    const r = await bundleScreen("Webstore", "SW")
    expect(r.Message.endsWith("...")).toBe(false)
    expect(r.Message.length).toBeGreaterThan(182)
  })
})

describe("hubtelRouter: flow registry", () => {
  it("every implemented main-menu service has an entry handler", () => {
    for (const [key, on] of Object.entries(IMPLEMENTED_SERVICES)) {
      if (on) expect(MAIN_MENU_ENTRIES[key as MainMenuKey], key).toBeTypeOf("function")
    }
  })
  it("every shop product has an entry handler", () => {
    for (const key of ["data", "airtime", "resultsChecker"] as const) {
      expect(SHOP_PRODUCT_ENTRIES[key], key).toBeTypeOf("function")
    }
  })
  it("replay with an unknown order table says already submitted instead of crashing (review focus #6)", async () => {
    const sup = fakeSupabase({ txRow: { order_table: "nope", order_id: "o1", expected_amount: 10, state: "awaiting_payment" } })
    const { deps } = makeDeps({}, sup)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("already submitted")
  })
  it("refuses to AddToCart a zero price and creates no order", async () => {
    const sup = fakeSupabase({ pkg: { price: 0, dealer_price: null, is_available: true } })
    const { deps } = makeDeps({ fetchBundles: async () => ({ bundles: [{ id: "pkg-1", size: "5", price: 0 }], total: 1 }) }, sup)
    await walkTo("CONFIRM", deps)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Type).toBe("release")
    expect(sup.inserts["ussd_orders"]).toBeUndefined()
  })
  it("an unknown step in a stored session restarts at the main menu", async () => {
    const { deps, store } = makeDeps()
    store.set("S1", { step: "NOT_A_STEP" as any, dialingPhone: "+233200585542", platform: "USSD" })
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toContain("Buy Data Bundle")
  })
})

describe("hubtelRouter: mode pinning (spec 4.2, review focus #3)", () => {
  const ALL_ON = { data: true, afa: true, airtime: true, resultsChecker: true }

  it("Initiation in main mode pins mode=main", async () => {
    const { deps, store } = makeDeps()
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(store.get("S1")).toMatchObject({ mode: "main", step: "MAIN" })
  })
  it("a main session keeps running main after the admin flips to shop", async () => {
    let mode: "main" | "shop" = "main"
    const { deps, store } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode, visibility: ALL_ON }) })
    const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(store.get("S1")?.mode).toBe("main")
    mode = "shop"
    const r = await hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Data Bundle") }), deps)
    expect(r.Message).toContain("Select Network:")
    expect(store.get("S1")?.step).toBe("SELECT_NETWORK")
  })
  it("a shop session keeps running shop after the admin flips to main (code step and product menu)", async () => {
    let mode: "main" | "shop" = "shop"
    const deductToken = vi.fn(async () => true)
    const { deps, store } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode, visibility: ALL_ON }), shop: fakeShop({ deductToken }) })
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    mode = "main"
    const r = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(r.Message).toContain("What would you like to buy?")
    expect(store.get("S1")).toMatchObject({ mode: "shop", step: "SHOP_PRODUCT" })
    const again = await hubtelRouter(req({ Message: "9" }), deps)
    expect(again.Message).toContain("What would you like to buy?")
    expect(deductToken).toHaveBeenCalledTimes(1)
  })
  it("a NEW session uses the current mode", async () => {
    let mode: "main" | "shop" = "main"
    const { deps, store } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode, visibility: ALL_ON }) })
    await hubtelRouter(req({ Type: "Initiation", SessionId: "S1" }), deps)
    mode = "shop"
    const r = await hubtelRouter(req({ Type: "Initiation", SessionId: "S2" }), deps)
    expect(r.Message).toContain("Enter shop code:")
    expect(store.get("S1")?.mode).toBe("main")
    expect(store.get("S2")?.mode).toBe("shop")
  })
  it("no session (expired, no order): restarts in the CURRENT mode", async () => {
    const { deps, store } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "shop", visibility: ALL_ON }) })
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toBe("Session expired.\nWelcome to Clingshub\nEnter shop code:\n0. Exit")
    expect(store.get("S1")).toMatchObject({ mode: "shop", step: "SHOP_ENTER_CODE" })
  })
  it("no session but a main cart awaiting payment: the cart is replayed even after a flip to shop", async () => {
    let mode: "main" | "shop" = "main"
    const sup = fakeSupabase({ pkg: { price: 10, dealer_price: null, is_available: true } })
    const { deps, store } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode, visibility: ALL_ON }) }, sup)
    await walkTo("CONFIRM", deps)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    expect(first.Type).toBe("AddToCart")
    expect(store.has("S1")).toBe(false)
    mode = "shop"
    const replay = await hubtelRouter(req({ Message: "1" }), deps)
    expect(replay.Type).toBe("AddToCart")
    expect(replay.Item).toEqual(first.Item)
    expect(store.has("S1")).toBe(false) // not restarted into the shop-code prompt
  })
  it("a session stored without a mode (written before Plan 3) runs as main even in shop mode", async () => {
    const { deps, store } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "shop", visibility: ALL_ON }) })
    store.set("S1", { step: "MAIN", dialingPhone: "+233200585542", platform: "USSD" })
    const menu = await hubtelRouter(req({ Type: "Initiation", SessionId: "S9" }), makeDeps().deps) // main menu text, for the digit
    const r = await hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Data Bundle") }), deps)
    expect(r.Message).toContain("Select Network:")
  })
  it("a step unknown to the session's mode restarts in the current mode", async () => {
    const { deps, store } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "main", visibility: ALL_ON }) })
    store.set("S1", { mode: "shop", step: "SELECT_NETWORK", dialingPhone: "+233200585542", platform: "USSD" })
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("Buy Data Bundle")
    expect(store.get("S1")?.mode).toBe("main")
  })
  it("a shop step in a main (or mode-less) session is never dispatched to the shop table", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps, store } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "main", visibility: ALL_ON }), shop: fakeShop({ deductToken }) })
    store.set("S1", { step: "SHOP_ENTER_CODE", dialingPhone: "+233200585542", platform: "USSD" })
    const r = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(r.Message).toContain("Buy Data Bundle")
    expect(deductToken).not.toHaveBeenCalled()
  })
  it("kill switch releases an in-flight shop session and bills nothing more (review focus #8)", async () => {
    let enabled = true
    const deductToken = vi.fn(async () => true)
    const { deps } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled, mode: "shop", visibility: ALL_ON }), shop: fakeShop({ deductToken }) })
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    enabled = false
    const r = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("Service unavailable")
    expect(deductToken).not.toHaveBeenCalled()
  })
  it("kill switch releases a shop session already on the product menu", async () => {
    let enabled = true
    const { deps } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled, mode: "shop", visibility: ALL_ON }) })
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    await hubtelRouter(req({ Message: "1234" }), deps)
    enabled = false
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("Service unavailable")
  })
})

describe("hubtelRouter: configurable welcome message", () => {
  const ALL_ON = { data: true, afa: true, airtime: true, resultsChecker: true }
  const CUSTOM = "Akwaaba to Ama Data Hub"
  const cfg = (mode: "main" | "shop", welcome: string) => async () =>
    ({ enabled: true, mode, visibility: ALL_ON, welcome, welcomeCustom: true, brandName: "Clingshub" })

  it("main mode: the custom welcome heads the initial main menu", async () => {
    const { deps } = makeDeps({ getConfig: cfg("main", CUSTOM) })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Message.split("\n")[0]).toBe(CUSTOM)
    expect(r.Message).not.toContain("Datagod")
  })
  it("main mode default: 'Welcome to Clingshub'", async () => {
    const { deps } = makeDeps()
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Message.split("\n")[0]).toBe("Welcome to Clingshub")
  })
  it("main mode: Redis-miss restart shows 'Session expired.' then the custom welcome", async () => {
    const { deps } = makeDeps({ getConfig: cfg("main", CUSTOM) })
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message.startsWith(`Session expired.\n${CUSTOM}\n1. Buy Data Bundle`)).toBe(true)
  })
  it("main mode: bad input re-shows the menu with the custom welcome", async () => {
    const { deps } = makeDeps({ getConfig: cfg("main", CUSTOM) })
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    const r = await hubtelRouter(req({ Message: "9" }), deps)
    expect(r.Message.split("\n")[0]).toBe(CUSTOM)
  })
  it("main mode: '0' back to main from a sub-flow shows the custom welcome", async () => {
    const { deps, store } = makeDeps({ getConfig: cfg("main", CUSTOM) })
    const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
    await hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Data Bundle") }), deps)
    expect(store.get("S1")?.step).toBe("SELECT_NETWORK")
    const back = await hubtelRouter(req({ Message: "0" }), deps)
    expect(store.get("S1")?.step).toBe("MAIN")
    expect(back.Message.split("\n")[0]).toBe(CUSTOM)
    expect(back.Message).toContain("Buy Data Bundle")
  })
  it("shop mode: the custom welcome heads the shop-code prompt", async () => {
    const { deps } = makeDeps({ getConfig: cfg("shop", CUSTOM) })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Message).toBe(`${CUSTOM}\nEnter shop code:\n0. Exit`)
  })
  it("shop mode: Redis-miss restart shows 'Session expired.' then the custom welcome", async () => {
    const { deps } = makeDeps({ getConfig: cfg("shop", CUSTOM) })
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toBe(`Session expired.\n${CUSTOM}\nEnter shop code:\n0. Exit`)
  })
  it("shop mode: later screens show the shop's name, not the welcome", async () => {
    const { deps } = makeDeps({ getConfig: cfg("shop", CUSTOM) })
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    const r = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(r.Message.split("\n")[0]).toBe("Ama Data Hub")
    expect(r.Message).not.toContain(CUSTOM)
  })
  it("longest (60-char) welcome + all four services (+ 'Session expired.') fits one USSD screen untruncated", async () => {
    const longest = "W".repeat(30) + " " + "x".repeat(29)
    expect(longest).toHaveLength(60)
    const { deps } = makeDeps({ getConfig: cfg("main", longest) })
    const replies = [
      await hubtelRouter(req({ Type: "Initiation" }), deps),
      await hubtelRouter(req({ Message: "1", SessionId: "S-miss" }), deps),
    ]
    expect(replies[1].Message.startsWith("Session expired.\n")).toBe(true)
    for (const r of replies) {
      expect(r.Message.length).toBeLessThanOrEqual(182)
      expect(r.Message).toContain(longest)
      for (const label of ["1. Buy Data Bundle", "2. AFA Registration", "3. Buy Airtime", "4. Results Checker"]) expect(r.Message).toContain(label)
      expect(r.Message.endsWith("\n0. Exit")).toBe(true)
    }
  })
})

describe("hubtelRouter: configurable brand name", () => {
  /** getConfig backed by the REAL getHubtelUssdConfig over a stored admin_settings blob. */
  const storedConfig = (value: Record<string, unknown>) => () => getHubtelUssdConfig({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { value: { enabled: true, ...value } }, error: null }) }) }) }),
  } as never)

  it("'0' on the main menu says goodbye with the brand", async () => {
    const { deps } = makeDeps({ getConfig: storedConfig({ brandName: "Ama Data" }) })
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    const r = await hubtelRouter(req({ Message: "0" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toBe("Thank you for using Ama Data.")
  })
  it("default brand: 'Thank you for using Clingshub.'", async () => {
    const { deps } = makeDeps({ getConfig: storedConfig({}) })
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    const r = await hubtelRouter(req({ Message: "0" }), deps)
    expect(r.Message).toBe("Thank you for using Clingshub.")
  })
  it("a custom brand flows into the derived welcome on the main menu", async () => {
    const { deps } = makeDeps({ getConfig: storedConfig({ brandName: "Ama Data", welcome: "Welcome to Clingshub" }) })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Message.split("\n")[0]).toBe("Welcome to Ama Data")
  })
  it("a custom brand flows into the derived welcome on the shop-code prompt", async () => {
    const { deps } = makeDeps({ getConfig: storedConfig({ mode: "shop", brandName: "Ama Data" }) })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Message).toBe("Welcome to Ama Data\nEnter shop code:\n0. Exit")
  })
  it("a custom welcome still wins over the brand", async () => {
    const { deps } = makeDeps({ getConfig: storedConfig({ brandName: "Ama Data", welcome: "Akwaaba!" }) })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Message.split("\n")[0]).toBe("Akwaaba!")
  })
})