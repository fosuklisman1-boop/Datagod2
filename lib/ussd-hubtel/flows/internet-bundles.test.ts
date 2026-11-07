// lib/ussd-hubtel/flows/internet-bundles.test.ts
// "Internet Bundles": one top-level item on both Hubtel codes that fronts Data Bundles and Standard Bundles.
import { describe, it, expect } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import type { HubtelUssdConfig } from "../config"
import { makeDeps, req, SHOP_CONFIG } from "../testing/fakes"

const OPEN = { networkPlans: true, payBills: true }
const INTERNET = "Internet Bundles\n1. Data Bundles\n2. Standard Bundles\n0. Back"
const MAIN_ALL = "Welcome to Clingshub\n1. Internet Bundles\n2. AFA Registration\n3. Buy Airtime\n4. Results Checker\n5. Pay Bills\n0. Exit"
const SHOP_ALL = "Ama Data Hub\nWhat would you like to buy?\n1. Internet Bundles\n2. Buy Airtime\n3. Results Checker\n4. Pay Bills\n0. Exit"

const vis = (over: Partial<HubtelUssdConfig["visibility"]> = {}): HubtelUssdConfig["visibility"] =>
  ({ data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: true, ...over })

const mainConfig = (over: Partial<HubtelUssdConfig["visibility"]> = {}) => async (): Promise<HubtelUssdConfig> => ({
  welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "main", visibility: vis(over),
})
const shopConfig = (over: Partial<HubtelUssdConfig["visibility"]> = {}) => async (): Promise<HubtelUssdConfig> => ({
  ...(await SHOP_CONFIG()), visibility: vis(over),
})

async function openMain(over: Partial<RouterDeps> = {}) {
  const made = makeDeps(over)
  const menu = await hubtelRouter(req({ Type: "Initiation" }), made.deps)
  return { ...made, menu }
}
async function openShop(over: Partial<RouterDeps> = {}) {
  const made = makeDeps({ getConfig: SHOP_CONFIG, ...over })
  await hubtelRouter(req({ Type: "Initiation" }), made.deps)
  const menu = await hubtelRouter(req({ Message: "1234" }), made.deps)
  return { ...made, menu }
}
const send = (deps: RouterDeps, Message: string) => hubtelRouter(req({ Message }), deps)

describe("Internet Bundles: menu text", () => {
  it("main menu with everything visible", async () => {
    const { menu } = await openMain({ botMenus: async () => OPEN })
    expect(menu.Message).toBe(MAIN_ALL)
  })
  it("shop menu with everything visible", async () => {
    const { menu } = await openShop({ botMenus: async () => OPEN })
    expect(menu.Message).toBe(SHOP_ALL)
    expect(menu.Message).toContain("1. Internet Bundles\n2. Buy Airtime\n3. Results Checker\n4. Pay Bills\n0. Exit")
  })
  it("neither type visible: no Internet Bundles line and the rest renumber from 1", async () => {
    const main = await openMain({ getConfig: mainConfig({ data: false }), botMenus: async () => ({ networkPlans: false, payBills: true }) })
    expect(main.menu.Message).toBe("Welcome to Clingshub\n1. AFA Registration\n2. Buy Airtime\n3. Results Checker\n4. Pay Bills\n0. Exit")
    const shop = await openShop({ getConfig: shopConfig({ data: false }), botMenus: async () => ({ networkPlans: false, payBills: true }) })
    expect(shop.menu.Message).toBe("Ama Data Hub\nWhat would you like to buy?\n1. Buy Airtime\n2. Results Checker\n3. Pay Bills\n0. Exit")
    expect(shop.menu.Message).not.toContain("Internet Bundles")
  })
})

describe.each([
  { mode: "main", open: openMain, config: mainConfig },
  { mode: "shop", open: openShop, config: shopConfig },
] as const)("Internet Bundles: $mode mode", ({ mode, open, config }) => {
  const steps = mode === "main"
    ? { data: "SELECT_NETWORK", dataText: "Select Network:\n1. MTN" }
    : { data: "SHOP_DATA_NETWORK", dataText: "Select Network:\n1. MTN" }
  const homeText = (menu: string) => menu

  it("both types visible: digit 1 shows the type screen on INTERNET_MENU", async () => {
    const { deps, store } = await open({ botMenus: async () => OPEN })
    const r = await send(deps, "1")
    expect(r.Message).toBe(INTERNET)
    expect(r.ClientState).toBe("INTERNET_MENU")
    expect(store.get("S1")?.step).toBe("INTERNET_MENU")
  })
  it("1 opens Data Bundles, 2 opens Standard Bundles", async () => {
    const a = await open({ botMenus: async () => OPEN })
    await send(a.deps, "1")
    const data = await send(a.deps, "1")
    expect(data.Message).toContain(steps.dataText)
    expect(a.store.get("S1")?.step).toBe(steps.data)
    const b = await open({ botMenus: async () => OPEN })
    await send(b.deps, "1")
    const np = await send(b.deps, "2")
    expect(np.Message.startsWith("Standard Bundles\nSelect network:")).toBe(true)
    expect(b.store.get("S1")?.step).toBe("NP_NETWORK")
  })
  it("only Data Bundles visible: digit 1 goes straight to the data network screen", async () => {
    const { deps, store } = await open()
    const r = await send(deps, "1")
    expect(r.Message).toContain(steps.dataText)
    expect(store.get("S1")?.step).toBe(steps.data)
  })
  it("only Standard Bundles visible: digit 1 opens Standard Bundles", async () => {
    const { deps, store } = await open({ getConfig: config({ data: false }), botMenus: async () => OPEN })
    const r = await send(deps, "1")
    expect(r.Message.startsWith("Standard Bundles\nSelect network:")).toBe(true)
    expect(store.get("S1")?.step).toBe("NP_NETWORK")
  })
  it("back from Data Bundles, both visible: the Internet Bundles screen", async () => {
    const { deps, store } = await open({ botMenus: async () => OPEN })
    await send(deps, "1")
    await send(deps, "1")
    const r = await send(deps, "0")
    expect(r.Message).toBe(INTERNET)
    expect(store.get("S1")?.step).toBe("INTERNET_MENU")
  })
  it("back from Standard Bundles, both visible: the Internet Bundles screen", async () => {
    const { deps, store } = await open({ botMenus: async () => OPEN })
    await send(deps, "1")
    await send(deps, "2")
    const r = await send(deps, "0")
    expect(r.Message).toBe(INTERNET)
    expect(store.get("S1")?.step).toBe("INTERNET_MENU")
  })
  it("back with one type visible: the main or shop menu", async () => {
    const dataOnly = await open()
    const home = dataOnly.menu.Message
    await send(dataOnly.deps, "1")
    expect((await send(dataOnly.deps, "0")).Message).toBe(homeText(home))
    const npOnly = await open({ getConfig: config({ data: false }), botMenus: async () => OPEN })
    const npHome = npOnly.menu.Message
    await send(npOnly.deps, "1")
    expect((await send(npOnly.deps, "0")).Message).toBe(npHome)
  })
  it("0 on INTERNET_MENU returns to the main or shop menu; an invalid digit repaints the screen", async () => {
    const { deps, store, menu } = await open({ botMenus: async () => OPEN })
    await send(deps, "1")
    for (const bad of ["9", "abc", "3"]) {
      const r = await send(deps, bad)
      expect(r.Message).toBe(INTERNET)
      expect(store.get("S1")?.step).toBe("INTERNET_MENU")
    }
    const back = await send(deps, "0")
    expect(back.Message).toBe(menu.Message)
    expect(store.get("S1")?.step).toBe(mode === "main" ? "MAIN" : "SHOP_PRODUCT")
  })
  it("a type hidden while the caller is on INTERNET_MENU: its digit repaints and opens nothing", async () => {
    let visibility = vis()
    const { deps, store } = await open({
      getConfig: async () => ({ ...(await (mode === "main" ? mainConfig() : shopConfig())()), visibility }),
      botMenus: async () => OPEN,
    })
    expect((await send(deps, "1")).Message).toBe(INTERNET)
    visibility = vis({ data: false })
    const r = await send(deps, "2")
    expect(r.Message).toBe("Internet Bundles\n1. Standard Bundles\n0. Back")
    expect(store.get("S1")?.step).toBe("INTERNET_MENU")
  })
})

describe("Internet Bundles: shop, data blocked", () => {
  it("offers only Standard Bundles, and Back returns to the product menu with the shop kept", async () => {
    const { deps, store, menu } = await openShop({ isDataBlocked: async () => true, botMenus: async () => OPEN })
    expect(menu.Message).toContain("1. Internet Bundles")
    const np = await send(deps, "1")
    expect(np.Message.startsWith("Standard Bundles\nSelect network:")).toBe(true)
    const back = await send(deps, "0")
    expect(back.Message).toBe(menu.Message)
    expect(store.get("S1")).toMatchObject({
      mode: "shop", step: "SHOP_PRODUCT", shopId: "shop-1", shopName: "Ama Data Hub", shopNetworks: ["MTN", "Telecel"],
    })
  })
  it("shop, both visible: back from the type screen keeps shopId, shopName and shopNetworks", async () => {
    const { deps, store } = await openShop({ botMenus: async () => OPEN })
    await send(deps, "1")
    expect(store.get("S1")).toMatchObject({ step: "INTERNET_MENU", mode: "shop", shopId: "shop-1", shopName: "Ama Data Hub", shopNetworks: ["MTN", "Telecel"] })
    await send(deps, "0")
    expect(store.get("S1")).toMatchObject({ step: "SHOP_PRODUCT", shopId: "shop-1", shopName: "Ama Data Hub", shopNetworks: ["MTN", "Telecel"] })
  })
})
