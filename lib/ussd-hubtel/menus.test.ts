import { describe, it, expect } from "vitest"
import { resolveMainMenu, mainMenuText, networkMenuText, bundleMenuText, confirmMenuText, formatSize, recipientPromptText, HUBTEL_NETWORKS, IMPLEMENTED_SERVICES,
  resolveShopMenu, shopHeader, shopCodePromptText, shopCodeRetryText, shopMenuText, shopNetworkLabel, sortShopNetworks, shopNetworkMenuText,
} from "./menus"

const allOn = { data: true, afa: true, airtime: true, resultsChecker: true }

describe("main menu", () => {
  it("shows only implemented services and renumbers", () => {
    const r = resolveMainMenu(allOn, false)
    expect(r.map(i => i.key)).toEqual(Object.entries(IMPLEMENTED_SERVICES).filter(([, v]) => v).map(([k]) => k))
    expect(mainMenuText(r)).toContain("1. Buy Data Bundle")
  })
  it("hides data when the caller is whitelist-blocked or admin-hidden", () => {
    expect(resolveMainMenu(allOn, true).map(i => i.key)).not.toContain("data")
    expect(resolveMainMenu({ ...allOn, data: false }, false).map(i => i.key)).not.toContain("data")
  })
})

describe("network menu", () => {
  it("uses real network names, never the Uzo nicknames", () => {
    const t = networkMenuText()
    for (const n of ["MTN", "Telecel", "AT iShare", "AT BigTime"]) expect(t).toContain(n)
    for (const nick of ["Yellow Plans", "Instant Blue", "Delay Blue", "Tele\n"]) expect(t).not.toContain(nick)
    expect(HUBTEL_NETWORKS.map(n => n.dbName)).toEqual(["MTN", "Telecel", "AT-iShare", "AT-BigTime"])
  })
})

describe("formatSize", () => {
  it("adds GB to bare numbers and leaves units alone", () => {
    expect(formatSize("5")).toBe("5GB")
    expect(formatSize("1.5")).toBe("1.5GB")
    expect(formatSize("500MB")).toBe("500MB")
    expect(formatSize("5GB")).toBe("5GB")
  })
})

describe("bundle menu", () => {
  const bundles = [{ id: "a", size: "1", price: 5 }, { id: "b", size: "2", price: 9.5 }]
  it("numbers across pages and offers More only when there is more", () => {
    expect(bundleMenuText(bundles, 0, 2, 5)).toBe("Select Package:\n1. 1GB - GHS 5.00\n2. 2GB - GHS 9.50\n0. Back")
    expect(bundleMenuText(bundles, 1, 12, 5)).toContain("6. 1GB - GHS 5.00")
    expect(bundleMenuText(bundles, 0, 12, 5)).toContain("3. More...")
  })
})

describe("confirm menu", () => {
  it("states amount, recipient and payer, with real network label", () => {
    const t = confirmMenuText("MTN", "5", 20, "0244123456", "0200585542")
    expect(t).toContain("5GB MTN")
    expect(t).toContain("To: 0244123456")
    expect(t).toContain("GHS 20.00")
    expect(t).toContain("1. Pay now")
    expect(recipientPromptText()).toContain("recipient")
  })
})

describe("shop menus", () => {
  const on = { data: true, afa: true, airtime: true, resultsChecker: true }
  it("lists data, airtime and results checker with real wording; never AFA", () => {
    expect(resolveShopMenu(on, false).map(i => i.label)).toEqual(["Buy Data Bundle", "Buy Airtime", "Results Checker"])
  })
  it("hides data for a whitelist-blocked caller and each service the admin hides", () => {
    expect(resolveShopMenu(on, true).map(i => i.key)).toEqual(["airtime", "resultsChecker"])
    expect(resolveShopMenu({ ...on, airtime: false }, false).map(i => i.key)).toEqual(["data", "resultsChecker"])
    expect(resolveShopMenu({ data: false, afa: true, airtime: false, resultsChecker: false }, false)).toEqual([])
  })
  it("shopHeader: printable ASCII, collapsed spaces, max 30 chars, never empty", () => {
    expect(shopHeader("Ama \u{1F31F} Data Hub & More Super Long Name Ltd")).toBe("Ama Data Hub & More Super Long")
    expect(shopHeader("\u{1F31F}\u{1F31F}")).toBe("Shop")
    expect(shopHeader("  Kofi's   Shop ")).toBe("Kofi's Shop")
  })
  it("code prompts", () => {
    expect(shopCodePromptText()).toBe("Welcome to Datagod\nEnter shop code:\n0. Exit")
    expect(shopCodeRetryText("Invalid code. Try again.")).toBe("Invalid code. Try again.\nEnter shop code:\n0. Exit")
  })
  it("product menu text", () => {
    expect(shopMenuText("Ama Data Hub", resolveShopMenu(on, false))).toBe(
      "Ama Data Hub\nWhat would you like to buy?\n1. Buy Data Bundle\n2. Buy Airtime\n3. Results Checker\n0. Exit"
    )
  })
  it("network labels and order: real names, known networks first, others as stored", () => {
    expect(shopNetworkLabel("AT-iShare")).toBe("AT iShare")
    expect(shopNetworkLabel("AirtelTigo")).toBe("AirtelTigo")
    expect(sortShopNetworks(["AT-BigTime", "Zeta", "MTN", "AirtelTigo", "Telecel"])).toEqual(["MTN", "Telecel", "AT-BigTime", "AirtelTigo", "Zeta"])
    const text = shopNetworkMenuText("Ama Data Hub", ["MTN", "AT-iShare"])
    expect(text).toBe("Ama Data Hub\nSelect Network:\n1. MTN\n2. AT iShare\n0. Back")
    for (const nick of ["Yellow Plans", "Tele\n", "Instant Blue", "Delay Blue"]) expect(text).not.toContain(nick)
  })
})
