// lib/ussd-hubtel/flows/shop.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { fakeShop, fakeShopBilling, makeDeps, req, SHOP_CODE, SHOP_CONFIG } from "../testing/fakes"

const PRODUCT_MENU = "Ama Data Hub\nWhat would you like to buy?\n1. Buy Data Bundle\n2. Buy Airtime\n3. Results Checker\n0. Exit"
const UNAVAILABLE_RETRY = "Shop unavailable. Try again.\nEnter shop code:\n0. Exit"
const NO_SESSIONS_RETRY = "Shop has no sessions left.\nEnter shop code:\n0. Exit"

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
  it("every shop service hidden for this caller: released before any code (no token can be spent)", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps, store } = makeDeps({
      getConfig: async () => ({ welcome: "Welcome to Clingshub", enabled: true, mode: "shop", visibility: { data: true, afa: true, airtime: false, resultsChecker: false } }),
      isDataBlocked: async () => true,
      shop: fakeShop({ deductToken }),
    })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toMatch(/no services/i)
    expect(store.has("S1")).toBe(false)
    // Even a code typed afterwards cannot bill: there is no session, and the restart releases again.
    const again = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(again.Type).toBe("release")
    expect(deductToken).not.toHaveBeenCalled()
  })
  it("AFA alone visible does not count as a shop service (the shop menu has no AFA)", async () => {
    const { deps } = makeDeps({
      getConfig: async () => ({ welcome: "Welcome to Clingshub", enabled: true, mode: "shop", visibility: { data: false, afa: true, airtime: false, resultsChecker: false } }),
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
  it("valid code (claimed + deducted): ONE token, product menu, shop stored with sorted networks, marker kept", async () => {
    const deductToken = vi.fn(async () => true)
    const networks = vi.fn(async () => ["AT-iShare", "MTN"])
    const billing = fakeShopBilling()
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken, networks }), shopBilling: billing })
    const r = await enterShop(deps)
    expect(deductToken).toHaveBeenCalledTimes(1)
    expect(deductToken).toHaveBeenCalledWith("code-1")
    expect(networks).toHaveBeenCalledWith("shop-1", undefined)
    expect(r.Type).toBe("response")
    expect(r.Message).toBe(PRODUCT_MENU)
    expect(r.ClientState).toBe("SHOP_PRODUCT")
    expect(billing.claimed).toEqual(new Set(["S1:code-1"]))
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
    it(`${name}: "Invalid code", no claim, no deduction, stays on the code step`, async () => {
      const deductToken = vi.fn(async () => true)
      const resolveCode = vi.fn(async () => (patch === null ? null : { ...SHOP_CODE, ...patch }))
      const billing = fakeShopBilling()
      const claim = vi.spyOn(billing, "claim")
      const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode, deductToken }), shopBilling: billing })
      const r = await enterShop(deps, input)
      expect(r.Message).toBe("Invalid code. Try again.\nEnter shop code:\n0. Exit")
      expect(deductToken).not.toHaveBeenCalled()
      expect(claim).not.toHaveBeenCalled()
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
  it("zero tokens before the RPC: 'no sessions left', no deduction, marker released (a top-up then works in the same session)", async () => {
    let balance = 0
    const deductToken = vi.fn(async () => true)
    const billing = fakeShopBilling()
    const { deps } = makeDeps({
      getConfig: SHOP_CONFIG,
      shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, tokenBalance: balance }), deductToken }),
      shopBilling: billing,
    })
    const r = await enterShop(deps)
    expect(r.Message).toBe(NO_SESSIONS_RETRY)
    expect(deductToken).not.toHaveBeenCalled()
    expect(billing.claimed.size).toBe(0)
    balance = 5
    const ok = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(ok.Message).toBe(PRODUCT_MENU)
    expect(deductToken).toHaveBeenCalledTimes(1)
  })
  it("negative / NaN balance is treated as no tokens (fail closed)", async () => {
    for (const tokenBalance of [-1, Number.NaN]) {
      const deductToken = vi.fn(async () => true)
      const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, tokenBalance }), deductToken }) })
      const r = await enterShop(deps)
      expect(r.Message, String(tokenBalance)).toBe(NO_SESSIONS_RETRY)
      expect(deductToken).not.toHaveBeenCalled()
    }
  })
  it("claimed + RPC false (balance hit 0 concurrently): 'no sessions left', marker released, a retry may deduct", async () => {
    const deductToken = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const billing = fakeShopBilling()
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken }), shopBilling: billing })
    const r = await enterShop(deps)
    expect(r.Message).toBe(NO_SESSIONS_RETRY)
    expect(billing.claimed.size).toBe(0)
    const ok = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(ok.Message).toBe(PRODUCT_MENU)
    expect(deductToken).toHaveBeenCalledTimes(2) // the retry was allowed to deduct
  })
  it("claimed + RPC THROWS: generic 'Shop unavailable', marker KEPT, a retry is accepted without a second deduction", async () => {
    const deductToken = vi.fn(async () => { throw new Error("rpc down secret-detail") })
    const billing = fakeShopBilling()
    const release = vi.spyOn(billing, "release")
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken }), shopBilling: billing })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await enterShop(deps)
    expect(r.Message).toBe(UNAVAILABLE_RETRY)
    expect(r.Message).not.toContain("rpc down")
    expect(release).not.toHaveBeenCalled()
    expect(billing.claimed).toEqual(new Set(["S1:code-1"])) // the deduction may have committed: never risk a second one
    expect(store.get("S1")?.step).toBe("SHOP_ENTER_CODE")
    expect(err).toHaveBeenCalled()
    for (const call of err.mock.calls) expect(JSON.stringify(call)).not.toContain("1234") // never the shop code itself
    err.mockRestore()
    const again = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(again.Message).toBe(PRODUCT_MENU)
    expect(deductToken).toHaveBeenCalledTimes(1) // worst case: one free session, never a double charge
  })
  it("marker 'already' held (this session paid for this code): accepted WITHOUT deducting, no low-session push", async () => {
    const deductToken = vi.fn(async () => true)
    const notifyLowTokens = vi.fn(async () => {})
    const { deps, store } = makeDeps({
      getConfig: SHOP_CONFIG,
      shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, tokenBalance: 0 }), deductToken, notifyLowTokens }),
      shopBilling: fakeShopBilling("already"),
    })
    const r = await enterShop(deps)
    expect(r.Message).toBe(PRODUCT_MENU)
    expect(deductToken).not.toHaveBeenCalled()
    expect(notifyLowTokens).not.toHaveBeenCalled()
    expect(store.get("S1")).toMatchObject({ step: "SHOP_PRODUCT", shopCodeId: "code-1" })
  })
  it("billing marker store error: 'Shop unavailable' and NO deduction", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken }), shopBilling: fakeShopBilling("error") })
    const r = await enterShop(deps)
    expect(r.Message).toBe(UNAVAILABLE_RETRY)
    expect(deductToken).not.toHaveBeenCalled()
    expect(store.get("S1")?.step).toBe("SHOP_ENTER_CODE")
  })
  it("low-session push only when the deduction leaves exactly 10", async () => {
    for (const [balance, pushes] of [[11, 1], [12, 0], [10, 0]] as const) {
      const notifyLowTokens = vi.fn(async () => {})
      const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, tokenBalance: balance }), notifyLowTokens }) })
      await enterShop(deps)
      expect(notifyLowTokens, `balance ${balance}`).toHaveBeenCalledTimes(pushes)
      if (pushes) expect(notifyLowTokens).toHaveBeenCalledWith("shop-1", "Ama Data Hub")
    }
  })
})

describe("shop mode: wrong-code cap (final wave M1)", () => {
  const TOO_MANY = "Too many attempts. Please try again later."
  it("3 wrong codes in a session: released with 'Too many attempts', session deleted, never billed", async () => {
    const deductToken = vi.fn(async () => true)
    const resolveCode = vi.fn(async () => null)
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode, deductToken }) })
    const first = await enterShop(deps, "1111")
    expect(first.Message).toBe("Invalid code. Try again.\nEnter shop code:\n0. Exit")
    expect(store.get("S1")?.shopCodeAttempts).toBe(1)
    const second = await hubtelRouter(req({ Message: "2222" }), deps)
    expect(second.Type).toBe("response")
    expect(store.get("S1")?.shopCodeAttempts).toBe(2)
    const third = await hubtelRouter(req({ Message: "3333" }), deps)
    expect(third.Type).toBe("release")
    expect(third.Message).toBe(TOO_MANY)
    expect(store.has("S1")).toBe(false)
    expect(deductToken).not.toHaveBeenCalled()
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
  it("two wrong codes then the right one: accepted and billed once", async () => {
    const deductToken = vi.fn(async () => true)
    const resolveCode = vi.fn(async (c: string) => (c === "1234" ? { ...SHOP_CODE } : null))
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode, deductToken }) })
    await enterShop(deps, "1111")
    await hubtelRouter(req({ Message: "2222" }), deps)
    const ok = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(ok.Message).toBe(PRODUCT_MENU)
    expect(deductToken).toHaveBeenCalledTimes(1)
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
  })
  it("'no sessions left' / 'unavailable' are not wrong codes: they do not count", async () => {
    const { deps, store } = makeDeps({
      getConfig: SHOP_CONFIG,
      shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, tokenBalance: 0 }) }),
    })
    await enterShop(deps)
    await hubtelRouter(req({ Message: "1234" }), deps)
    const r = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toBe(NO_SESSIONS_RETRY)
    expect(store.get("S1")?.shopCodeAttempts ?? 0).toBe(0)
  })
})

describe("shop mode: networks() failing after the deduction (final wave M4)", () => {
  it("logs ids only and still shows the product menu (empty network list); the token stays spent once", async () => {
    const deductToken = vi.fn(async () => true)
    const networks = vi.fn(async () => { throw Object.assign(new Error("timeout Failing row contains (0244123456)"), { code: "57014" }) })
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken, networks }) })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await enterShop(deps)
    const logged = JSON.stringify(err.mock.calls)
    err.mockRestore()
    expect(r.Type).toBe("response")
    expect(r.Message).toBe(PRODUCT_MENU)
    expect(store.get("S1")).toMatchObject({ step: "SHOP_PRODUCT", shopNetworks: [] })
    expect(deductToken).toHaveBeenCalledTimes(1)
    expect(logged).toContain("shop-1")
    expect(logged).not.toContain("0244123456")
    expect(logged).not.toContain("1234")
  })
})

describe("shop mode: token billing per Hubtel session (review focus #1)", () => {
  it("the same code re-sent after acceptance (lost reply): product menu again, ONE deduction", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken }) })
    await enterShop(deps)
    const again = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(again.Message).toBe(PRODUCT_MENU)
    expect(deductToken).toHaveBeenCalledTimes(1)
  })
  it("two concurrent deliveries of the code: ONE deduction, both see the product menu", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken }) })
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    const [a, b] = await Promise.all([hubtelRouter(req({ Message: "1234" }), deps), hubtelRouter(req({ Message: "1234" }), deps)])
    expect(deductToken).toHaveBeenCalledTimes(1)
    expect(a.Message).toBe(PRODUCT_MENU)
    expect(b.Message).toBe(PRODUCT_MENU)
  })
  it("session lost after acceptance (Redis miss), ENTER_SHOP_CODE restarted, same code: no second deduction even at balance 0", async () => {
    let balance = 50
    const deductToken = vi.fn(async () => { balance -= 1; return true })
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, tokenBalance: balance }), deductToken }) })
    await enterShop(deps)
    store.delete("S1") // Redis TTL / miss; the billing marker (1 h TTL) survives
    balance = 0
    const restart = await hubtelRouter(req({ Message: "1" }), deps)
    expect(restart.Message).toBe("Session expired.\nWelcome to Clingshub\nEnter shop code:\n0. Exit")
    const r = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(r.Message).toBe(PRODUCT_MENU)
    expect(deductToken).toHaveBeenCalledTimes(1)
  })
  it("two different shops' codes in one session: each billed exactly once, re-entry of either bills nothing more", async () => {
    const deductToken = vi.fn(async () => true)
    const resolveCode = async (code: string) =>
      code === "1234" ? { ...SHOP_CODE } : code === "5678" ? { ...SHOP_CODE, shopCodeId: "code-2", shopId: "shop-2", shopName: "Kofi Shop" } : null
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode, deductToken }) })
    await enterShop(deps)
    store.delete("S1")
    await hubtelRouter(req({ Message: "1" }), deps)
    const kofi = await hubtelRouter(req({ Message: "5678" }), deps)
    expect(kofi.Message.split("\n")[0]).toBe("Kofi Shop")
    expect(store.get("S1")).toMatchObject({ shopCodeId: "code-2", shopId: "shop-2" })
    expect(deductToken.mock.calls).toEqual([["code-1"], ["code-2"]])
    for (const code of ["1234", "5678"]) {
      store.delete("S1")
      await hubtelRouter(req({ Message: "1" }), deps)
      expect((await hubtelRouter(req({ Message: code }), deps)).ClientState).toBe("SHOP_PRODUCT")
    }
    expect(deductToken).toHaveBeenCalledTimes(2)
  })
  it("separate Hubtel sessions are billed separately", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken }) })
    await enterShop(deps, "1234", "S1")
    await enterShop(deps, "1234", "S2")
    expect(deductToken).toHaveBeenCalledTimes(2)
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
    const { deps } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", enabled: true, mode: "shop", visibility: { data: true, afa: true, airtime: false, resultsChecker: true } }) })
    const r = await enterShop(deps)
    expect(r.Message).not.toContain("Buy Airtime")
    expect(r.Message).not.toContain("AFA")
  })
  it("an unknown pick re-shows the menu without billing again", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken }) })
    await enterShop(deps)
    const r = await hubtelRouter(req({ Message: "9" }), deps)
    expect(r.Message).toBe(PRODUCT_MENU)
    expect(r.ClientState).toBe("SHOP_PRODUCT")
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
    expect(deductToken).toHaveBeenCalledTimes(1)
  })
})
