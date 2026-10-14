// lib/ussd-hubtel/flows/shop.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { fakeShop, makeDeps, req, SHOP_CODE, SHOP_CONFIG } from "../testing/fakes"

const PRODUCT_MENU = "Ama Data Hub\nWhat would you like to buy?\n1. Buy Data Bundle\n2. Buy Airtime\n3. Results Checker\n0. Exit"
const INVALID_RETRY = "Invalid code. Try again.\nEnter shop code:\n0. Exit"

/** Initiation in shop mode, then the code. Returns the reply to the code. */
async function enterShop(deps: RouterDeps, code = "1234", sid = "S1") {
  await hubtelRouter(req({ Type: "Initiation", SessionId: sid }), deps)
  return hubtelRouter(req({ Message: code, SessionId: sid }), deps)
}

describe("shop mode: initiation", () => {
  it("asks for the shop code first (text field) and pins mode=shop", async () => {
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toBe("Welcome to Clingshub\nEnter shop code:\n0. Exit")
    expect(r.FieldType).toBe("text")
    expect(r.ClientState).toBe("SHOP_ENTER_CODE")
    expect(store.get("S1")).toMatchObject({ mode: "shop", step: "SHOP_ENTER_CODE", dialingPhone: "+233200585542", platform: "USSD", dataBlocked: false })
  })
  it("every shop service hidden for this caller: released before any code", async () => {
    const resolveCode = vi.fn(async () => ({ ...SHOP_CODE }))
    const { deps, store } = makeDeps({
      getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "shop", visibility: { data: true, afa: true, airtime: false, resultsChecker: false } }),
      isDataBlocked: async () => true,
      shop: fakeShop({ resolveCode }),
    })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toMatch(/no services/i)
    expect(store.has("S1")).toBe(false)
    // A code typed afterwards finds no session, and the restart releases again.
    const again = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(again.Type).toBe("release")
    expect(resolveCode).not.toHaveBeenCalled()
  })
  it("AFA alone visible does not count as a shop service (the shop menu has no AFA)", async () => {
    const { deps } = makeDeps({
      getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "shop", visibility: { data: false, afa: true, airtime: false, resultsChecker: false } }),
    })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toMatch(/no services/i)
  })
  it("'0' at the code prompt says goodbye", async () => {
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG })
    const r = await enterShop(deps, "0")
    expect(r.Type).toBe("release")
    expect(r.Message).toBe("Goodbye.")
    expect(store.has("S1")).toBe(false)
  })
})

describe("shop mode: shop code (review focus #2)", () => {
  it("valid code: product menu, shop stored with sorted networks", async () => {
    const networks = vi.fn(async () => ["AT-iShare", "MTN"])
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ networks }) })
    const r = await enterShop(deps)
    expect(networks).toHaveBeenCalledWith("shop-1", undefined)
    expect(r.Type).toBe("response")
    expect(r.Message).toBe(PRODUCT_MENU)
    expect(r.ClientState).toBe("SHOP_PRODUCT")
    expect(store.get("S1")).toMatchObject({
      mode: "shop", step: "SHOP_PRODUCT", shopCodeId: "code-1", shopId: "shop-1", shopName: "Ama Data Hub", shopNetworks: ["MTN", "AT-iShare"],
    })
    expect(store.get("S1")?.parentShopId).toBeUndefined()
  })
  it("the code prompt is a text field on every retry screen", async () => {
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG })
    const r = await enterShop(deps, "9999")
    expect(r.FieldType).toBe("text")
    expect(r.ClientState).toBe("SHOP_ENTER_CODE")
  })
  it("sub-agent shop: the parent id is stored and used for the catalog", async () => {
    const networks = vi.fn(async () => ["MTN"])
    const { deps, store } = makeDeps({
      getConfig: SHOP_CONFIG,
      shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, parentShopId: "parent-1" }), networks }),
    })
    await enterShop(deps)
    expect(networks).toHaveBeenCalledWith("shop-1", "parent-1")
    expect(store.get("S1")?.parentShopId).toBe("parent-1")
  })
  it("a long / non-ASCII shop name is sanitised in the product menu header", async () => {
    const { deps, store } = makeDeps({
      getConfig: SHOP_CONFIG,
      shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, shopName: "Ama \u{1F31F} Data Hub & More Super Long Name Ltd" }) }),
    })
    const r = await enterShop(deps)
    expect(r.Message.split("\n")[0]).toBe("Ama Data Hub & More Super Long")
    // Re-shown menus use the same sanitised header.
    const again = await hubtelRouter(req({ Message: "9" }), deps)
    expect(again.Message.split("\n")[0]).toBe("Ama Data Hub & More Super Long")
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
  })
  const refused: Array<[string, Partial<typeof SHOP_CODE> | null, string]> = [
    ["unknown code", null, "1234"],
    ["inactive code", { status: "inactive" }, "1234"],
    ["suspended code", { status: "suspended" }, "1234"],
    ["malformed input", {}, "12#4"],
    ["too long", {}, "123456789"],
    ["empty input", {}, ""],
  ]
  for (const [name, patch, input] of refused) {
    it(`${name}: "Invalid code", stays on the code step`, async () => {
      const resolveCode = vi.fn(async () => (patch === null ? null : { ...SHOP_CODE, ...patch }))
      const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode }) })
      const r = await enterShop(deps, input)
      expect(r.Message).toBe(INVALID_RETRY)
      expect(store.get("S1")?.step).toBe("SHOP_ENTER_CODE")
      if (input === "12#4" || input === "123456789" || input === "") expect(resolveCode).not.toHaveBeenCalled()
    })
  }
  it("alphanumeric codes up to 8 chars are looked up", async () => {
    const resolveCode = vi.fn(async () => null)
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode }) })
    await enterShop(deps, "Ab12Cd34")
    expect(resolveCode).toHaveBeenCalledWith("Ab12Cd34")
  })
})

describe("shop mode: wrong-code cap (final wave M1)", () => {
  const TOO_MANY = "Too many attempts. Please try again later."
  it("3 wrong codes in a session: released with 'Too many attempts', session deleted", async () => {
    const resolveCode = vi.fn(async () => null)
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode }) })
    const first = await enterShop(deps, "1111")
    expect(first.Message).toBe(INVALID_RETRY)
    expect(store.get("S1")?.shopCodeAttempts).toBe(1)
    const second = await hubtelRouter(req({ Message: "2222" }), deps)
    expect(second.Type).toBe("response")
    expect(store.get("S1")?.shopCodeAttempts).toBe(2)
    const third = await hubtelRouter(req({ Message: "3333" }), deps)
    expect(third.Type).toBe("release")
    expect(third.Message).toBe(TOO_MANY)
    expect(store.has("S1")).toBe(false)
  })
  it("malformed, unknown and inactive codes all count toward the cap", async () => {
    const resolveCode = vi.fn(async (c: string) => (c === "5555" ? { ...SHOP_CODE, status: "inactive" } : null))
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode }) })
    await enterShop(deps, "12#4") // malformed
    await hubtelRouter(req({ Message: "5555" }), deps) // inactive
    const r = await hubtelRouter(req({ Message: "9999" }), deps) // unknown
    expect(r.Type).toBe("release")
    expect(r.Message).toBe(TOO_MANY)
    expect(store.has("S1")).toBe(false)
  })
  it("two wrong codes then the right one: accepted", async () => {
    const resolveCode = vi.fn(async (c: string) => (c === "1234" ? { ...SHOP_CODE } : null))
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode }) })
    await enterShop(deps, "1111")
    await hubtelRouter(req({ Message: "2222" }), deps)
    const ok = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(ok.Message).toBe(PRODUCT_MENU)
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
  })
})

describe("shop mode: networks() failing after code acceptance (final wave M4)", () => {
  it("logs ids only and still shows the product menu (empty network list)", async () => {
    const networks = vi.fn(async () => { throw Object.assign(new Error("timeout Failing row contains (0244123456)"), { code: "57014" }) })
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ networks }) })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await enterShop(deps)
    const logged = JSON.stringify(err.mock.calls)
    err.mockRestore()
    expect(r.Type).toBe("response")
    expect(r.Message).toBe(PRODUCT_MENU)
    expect(store.get("S1")).toMatchObject({ step: "SHOP_PRODUCT", shopNetworks: [] })
    expect(logged).toContain("shop-1")
    expect(logged).not.toContain("0244123456")
    expect(logged).not.toContain("1234")
  })
})

describe("shop mode: no session billing (spec 2026-10-14)", () => {
  it("a shop at token balance 0 is accepted: product menu, shop stored", async () => {
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, tokenBalance: 0 }) }) })
    const r = await enterShop(deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toBe(PRODUCT_MENU)
    expect(store.get("S1")).toMatchObject({ step: "SHOP_PRODUCT", shopCodeId: "code-1", shopId: "shop-1" })
  })
  it("a negative / NaN balance is ignored too", async () => {
    for (const tokenBalance of [-3, Number.NaN]) {
      const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, tokenBalance }) }) })
      expect((await enterShop(deps)).Message, `balance ${tokenBalance}`).toBe(PRODUCT_MENU)
    }
  })
  it("the same code re-sent after acceptance (lost reply): product menu again", async () => {
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG })
    await enterShop(deps)
    const again = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(again.Message).toBe(PRODUCT_MENU)
  })
  it("two concurrent deliveries of the code: both see the product menu", async () => {
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG })
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    const [a, b] = await Promise.all([hubtelRouter(req({ Message: "1234" }), deps), hubtelRouter(req({ Message: "1234" }), deps)])
    expect(a.Message).toBe(PRODUCT_MENU)
    expect(b.Message).toBe(PRODUCT_MENU)
  })
  it("inactive and suspended codes are still refused as wrong codes", async () => {
    for (const status of ["inactive", "suspended"]) {
      const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, status, tokenBalance: 99 }) }) })
      const r = await enterShop(deps)
      expect(r.Message, status).toBe(INVALID_RETRY)
      expect(store.get("S1")?.step).toBe("SHOP_ENTER_CODE")
    }
  })
})

describe("shop mode: product menu", () => {
  it("'0' says goodbye", async () => {
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG })
    await enterShop(deps)
    const r = await hubtelRouter(req({ Message: "0" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toBe("Goodbye.")
  })
  it("whitelist-blocked caller: no data item", async () => {
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG, isDataBlocked: async () => true })
    const r = await enterShop(deps)
    expect(r.Message).toBe("Ama Data Hub\nWhat would you like to buy?\n1. Buy Airtime\n2. Results Checker\n0. Exit")
  })
  it("an admin-hidden service is not offered", async () => {
    const { deps } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "shop", visibility: { data: true, afa: true, airtime: false, resultsChecker: true } }) })
    const r = await enterShop(deps)
    expect(r.Message).not.toContain("Buy Airtime")
    expect(r.Message).not.toContain("AFA")
  })
  it("an unknown pick re-shows the menu", async () => {
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG })
    await enterShop(deps)
    const r = await hubtelRouter(req({ Message: "9" }), deps)
    expect(r.Message).toBe(PRODUCT_MENU)
    expect(r.ClientState).toBe("SHOP_PRODUCT")
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
  })
})

describe("shop mode: code typed after the session record was lost", () => {
  it("ClientState SHOP_ENTER_CODE: the code is processed (product menu), not 'Session expired'", async () => {
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG })
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    store.delete("S1") // Redis miss / TTL between the prompt and the code
    const r = await hubtelRouter(req({ Message: "1234", ClientState: "SHOP_ENTER_CODE" }), deps)
    expect(r.Message).toBe(PRODUCT_MENU)
    expect(store.get("S1")).toMatchObject({ mode: "shop", step: "SHOP_PRODUCT", shopId: "shop-1", dialingPhone: "+233200585542" })
  })
  it("a wrong code after the loss is a normal retry on the code prompt", async () => {
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG })
    const r = await hubtelRouter(req({ Message: "9999", ClientState: "SHOP_ENTER_CODE" }), deps)
    expect(r.Message).toBe(INVALID_RETRY)
    expect(store.get("S1")).toMatchObject({ mode: "shop", step: "SHOP_ENTER_CODE", shopCodeAttempts: 1 })
  })
  it("a redelivered code after the loss shows the product menu", async () => {
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG })
    await hubtelRouter(req({ Message: "1234", ClientState: "SHOP_ENTER_CODE" }), deps)
    store.delete("S1")
    const again = await hubtelRouter(req({ Message: "1234", ClientState: "SHOP_ENTER_CODE" }), deps)
    expect(again.Message).toBe(PRODUCT_MENU)
  })
  it("without the echoed ClientState it still restarts with 'Session expired'", async () => {
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG })
    const r = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(r.Message).toBe("Session expired.\nWelcome to Clingshub\nEnter shop code:\n0. Exit")
  })
})
