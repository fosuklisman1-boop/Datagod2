// lib/ussd-hubtel/router.bot-menus.test.ts
// Network Plans / Pay Bills menu entries: visible only when the cashback bots gate (enabled && surfaces.bots &&
// botGroups[group]) AND the Hubtel visibility flag are on. Hidden, the main and shop menus are byte-identical to
// the pre-cashback menus (numbering included); a failed gate load hides them (fail closed).
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter } from "./router"
import { botMenuGate, loadBotMenuGate } from "./services"
import { resolveCashbackConfig } from "@/lib/cashback/config"
import { makeDeps, req, SHOP_CONFIG } from "./testing/fakes"
import type { HubtelUssdConfig, BotMenuGate } from "./config"

const OPEN: BotMenuGate = { networkPlans: true, payBills: true }
const MAIN_LEGACY = "Welcome to Clingshub\n1. Buy Data Bundle\n2. AFA Registration\n3. Buy Airtime\n4. Results Checker\n0. Exit"
const MAIN_SHOWN = "Welcome to Clingshub\n1. Buy Data Bundle\n2. AFA Registration\n3. Buy Airtime\n4. Results Checker\n5. Network Plans\n6. Pay Bills\n0. Exit"
const SHOP_LEGACY = "Ama Data Hub\nWhat would you like to buy?\n1. Buy Data Bundle\n2. Buy Airtime\n3. Results Checker\n0. Exit"
const SHOP_SHOWN = "Ama Data Hub\nWhat would you like to buy?\n1. Buy Data Bundle\n2. Buy Airtime\n3. Results Checker\n4. Network Plans\n5. Pay Bills\n0. Exit"

const mainConfig = (over: Partial<HubtelUssdConfig["visibility"]> = {}) => async (): Promise<HubtelUssdConfig> => ({
  welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "main",
  visibility: { data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: true, ...over },
})

describe("bot menus: main mode", () => {
  it("hidden (gate closed): the main menu is byte-identical and 5 just repaints it", async () => {
    const { deps } = makeDeps()
    const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(menu.Message).toBe(MAIN_LEGACY)
    const r = await hubtelRouter(req({ Message: "5" }), deps)
    expect(r.Message).toBe(MAIN_LEGACY)
  })
  it("shown: appended as 5 Network Plans / 6 Pay Bills; each digit opens its flow", async () => {
    const { deps, store } = makeDeps({ botMenus: async () => OPEN })
    expect((await hubtelRouter(req({ Type: "Initiation" }), deps)).Message).toBe(MAIN_SHOWN)
    const np = await hubtelRouter(req({ Message: "5" }), deps)
    expect(np.Message.startsWith("Network Plans\nSelect network:")).toBe(true)
    expect(store.get("S1")?.step).toBe("NP_NETWORK")
    // Back to the main menu: still shows the bot menus.
    expect((await hubtelRouter(req({ Message: "0" }), deps)).Message).toBe(MAIN_SHOWN)
    const pb = await hubtelRouter(req({ Message: "6" }), deps)
    expect(pb.Message.startsWith("Pay Bills\n")).toBe(true)
    expect(store.get("S1")?.step).toBe("PB_BILLER")
  })
  it("one group on: only its menu shows, numbered right after the existing items", async () => {
    const { deps } = makeDeps({ botMenus: async () => ({ networkPlans: false, payBills: true }) })
    const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(menu.Message).toBe(MAIN_LEGACY.replace("\n0. Exit", "\n5. Pay Bills\n0. Exit"))
    expect(store_step(await hubtelRouter(req({ Message: "5" }), deps))).toBe("PB_BILLER")
  })
  it("the Hubtel visibility flag off hides a menu even with the gate open", async () => {
    const { deps } = makeDeps({ getConfig: mainConfig({ networkPlans: false, payBills: false }), botMenus: async () => OPEN })
    expect((await hubtelRouter(req({ Type: "Initiation" }), deps)).Message).toBe(MAIN_LEGACY)
  })
  it("a gate load that throws hides both menus (fail closed) and the session still works", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const { deps } = makeDeps({ botMenus: async () => { throw new Error("db down") } })
    expect((await hubtelRouter(req({ Type: "Initiation" }), deps)).Message).toBe(MAIN_LEGACY)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

/** ClientState of a reply is the step name. */
const store_step = (r: { ClientState?: string }) => r.ClientState

describe("bot menus: shop mode", () => {
  async function enterShop(open: boolean) {
    const made = makeDeps({ getConfig: SHOP_CONFIG, ...(open ? { botMenus: async () => OPEN } : {}) })
    await hubtelRouter(req({ Type: "Initiation" }), made.deps)
    const menu = await hubtelRouter(req({ Message: "1234" }), made.deps)
    return { ...made, menu }
  }
  it("hidden: the product menu is byte-identical and 4 just repaints it", async () => {
    const { deps, menu } = await enterShop(false)
    expect(menu.Message).toBe(SHOP_LEGACY)
    expect((await hubtelRouter(req({ Message: "4" }), deps)).Message).toBe(SHOP_LEGACY)
  })
  it("shown: 4 Network Plans / 5 Pay Bills open the flows in shop mode; 0 returns to the shop menu", async () => {
    const { deps, store, menu } = await enterShop(true)
    expect(menu.Message).toBe(SHOP_SHOWN)
    const np = await hubtelRouter(req({ Message: "4" }), deps)
    expect(np.Message.startsWith("Network Plans\nSelect network:")).toBe(true)
    expect(store.get("S1")).toMatchObject({ mode: "shop", step: "NP_NETWORK", shopId: "shop-1" })
    expect((await hubtelRouter(req({ Message: "0" }), deps)).Message).toBe(SHOP_SHOWN)
    const pb = await hubtelRouter(req({ Message: "5" }), deps)
    expect(pb.Message.startsWith("Pay Bills\n")).toBe(true)
    expect(store.get("S1")).toMatchObject({ mode: "shop", step: "PB_BILLER" })
  })
})

describe("botMenuGate / loadBotMenuGate", () => {
  const cfg = (raw: Record<string, unknown>) => resolveCashbackConfig(raw)
  it("needs enabled AND surfaces.bots AND the group (bundles => Network Plans, bills => Pay Bills)", () => {
    const all = { enabled: true, surfaces: { bots: true }, botGroups: { bundles: true, bills: true } }
    expect(botMenuGate(cfg(all))).toEqual(OPEN)
    expect(botMenuGate(cfg({ ...all, enabled: false }))).toEqual({ networkPlans: false, payBills: false })
    expect(botMenuGate(cfg({ ...all, surfaces: { bots: false, storefront: true } }))).toEqual({ networkPlans: false, payBills: false })
    expect(botMenuGate(cfg({ ...all, botGroups: { bundles: true } }))).toEqual({ networkPlans: true, payBills: false })
    expect(botMenuGate(cfg({ ...all, botGroups: { bills: true, airtime: true } }))).toEqual({ networkPlans: false, payBills: true })
    expect(botMenuGate(cfg({}))).toEqual({ networkPlans: false, payBills: false })
  })
  const db = (result: { data: unknown; error: unknown } | Error) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { if (result instanceof Error) throw result; return result } }) }) }),
  }) as never
  it("reads the stored cashback config", async () => {
    const value = { enabled: true, surfaces: { bots: true }, botGroups: { bundles: true, bills: true } }
    expect(await loadBotMenuGate(db({ data: { value }, error: null }))).toEqual(OPEN)
  })
  it("fails closed on a read error or a throw", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await loadBotMenuGate(db({ data: null, error: { message: "boom" } }))).toEqual({ networkPlans: false, payBills: false })
    expect(await loadBotMenuGate(db(new Error("network")))).toEqual({ networkPlans: false, payBills: false })
    err.mockRestore()
  })
})
