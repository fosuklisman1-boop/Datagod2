// lib/ussd-hubtel/router.lines.test.ts
// Each Hubtel code reaches the router with its own settings through deps.getConfig (see the interaction route).
import { describe, it, expect } from "vitest"
import { hubtelRouter } from "./router"
import { USSD_SCREEN_LIMIT } from "./protocol"
import { fakeSupabase, makeDeps, req } from "./testing/fakes"
import type { BotMenuGate, HubtelUssdConfig } from "./config"

const OPEN: BotMenuGate = { networkPlans: true, payBills: true }
const ALL_ON = { data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: true }
const SIX = "1. Internet Bundles\n2. AFA Registration\n3. Buy Airtime\n4. Results Checker\n5. Pay Bills\n0. Exit"

const line = (over: Partial<HubtelUssdConfig> = {}) => async (): Promise<HubtelUssdConfig> => ({
  welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "main", visibility: ALL_ON, ...over,
})

describe("hubtelRouter: separate lines", () => {
  it("the main line opens all six services and pins main mode", async () => {
    const { deps, store } = makeDeps({ getConfig: line(), botMenus: async () => OPEN })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toBe(`Welcome to Clingshub\n${SIX}`)
    expect(store.get("S1")?.mode).toBe("main")
  })

  it("a main line that is off releases, even with a live main session", async () => {
    const { deps, store } = makeDeps({ getConfig: line({ enabled: false }) })
    store.set("S1", { mode: "main", step: "MAIN", dialingPhone: "+233200585542", platform: "USSD" })
    expect((await hubtelRouter(req({ Message: "1" }), deps)).Type).toBe("release")
  })

  it("the existing line in shop mode still opens the shop-code prompt", async () => {
    const { deps } = makeDeps({ getConfig: line({ mode: "shop", welcome: "Welcome customer", welcomeCustom: true }) })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Message).toBe("Welcome customer\nEnter shop code:\n0. Exit")
  })

  it("a lost session on the main line restarts on the main menu, never the shop prompt", async () => {
    const { deps } = makeDeps({ getConfig: line(), botMenus: async () => OPEN })
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toBe(`Session expired.\nWelcome to Clingshub\n${SIX}`)
  })

  it("a lost session with a cart awaiting payment replays it on the main line", async () => {
    const sup = fakeSupabase({
      txRow: { order_table: "ussd_orders", order_id: "o1", expected_amount: 10, state: "awaiting_payment" },
      orderRow: { package_size: "5", network: "MTN" },
    })
    const { deps } = makeDeps({ getConfig: line(), botMenus: async () => OPEN }, sup)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Message).not.toContain("Internet Bundles")
  })

  it("keeps the whole menu on screen when the expiry notice would overflow it", async () => {
    // The Internet Bundles menu is shorter than the old six-line one, so the welcome is longer than the admin
    // limit (60) to keep the notice from fitting: this tests the router's fallback, not the validator.
    const welcome = "W".repeat(80)
    const { deps } = makeDeps({ getConfig: line({ welcome, welcomeCustom: true }), botMenus: async () => OPEN })
    const r = await hubtelRouter(req({ Message: "1", Platform: "USSD" }), deps)
    expect(r.Message.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
    expect(r.Message).toBe(`${welcome}\n${SIX}`)
  })
})
