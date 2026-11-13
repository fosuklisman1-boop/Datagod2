import { describe, it, expect } from "vitest"
import { resolveMainMenu, mainMenuText, networkMenuText, bundleMenuText, confirmMenuText, whoForText, formatSize, recipientPromptText, HUBTEL_NETWORKS, IMPLEMENTED_SERVICES,
  resolveInternetTypes, internetMenuText,
  resolveShopMenu, shopHeader, shopCodePromptText, shopCodeRetryText, shopMenuText, shopNetworkLabel, sortShopNetworks, shopNetworkMenuText,
} from "./menus"
import { DEFAULT_BRAND, DEFAULT_WELCOME } from "./config"
import { mainExitText } from "./menus"

const allOn = { data: true, afa: true, airtime: true, resultsChecker: true }

describe("main menu", () => {
  it("shows only implemented services and renumbers", () => {
    const r = resolveMainMenu({ ...allOn, networkPlans: true, payBills: true }, false, { networkPlans: true, payBills: true })
    // Every implemented service is reachable: directly from the menu, or through the Internet Bundles item.
    const reachable = new Set<string>(r.map(i => i.key))
    if (reachable.has("internet")) { reachable.add("data"); reachable.add("networkPlans") }
    for (const [k, v] of Object.entries(IMPLEMENTED_SERVICES)) if (v) expect(reachable.has(k), k).toBe(true)
    expect(mainMenuText(r, DEFAULT_WELCOME)).toContain("1. Internet Bundles")
  })
  it("main menu with all visible", () => {
    const r = resolveMainMenu({ ...allOn, networkPlans: true, payBills: true }, false, { networkPlans: true, payBills: true })
    expect(mainMenuText(r, DEFAULT_WELCOME)).toBe(
      "Welcome to Clingshub\n1. Internet Bundles\n2. AFA Registration\n3. Buy Airtime\n4. Results Checker\n5. Pay Bills\n0. Exit"
    )
  })
  it("shop menu with all visible", () => {
    const r = resolveShopMenu({ ...allOn, networkPlans: true, payBills: true }, false, { networkPlans: true, payBills: true })
    expect(shopMenuText("Ama Data Hub", r)).toContain("1. Internet Bundles\n2. Buy Airtime\n3. Results Checker\n4. Pay Bills\n0. Exit")
  })
  it("bot menus need BOTH the admin flag and the cashback gate; no gate given = hidden", () => {
    const vis = { ...allOn, networkPlans: true, payBills: true }
    expect(resolveMainMenu(vis, false).map(i => i.key)).toEqual(["internet", "afa", "airtime", "resultsChecker"])
    expect(resolveMainMenu(allOn, false, { networkPlans: true, payBills: true }).map(i => i.key)).toEqual(["internet", "afa", "airtime", "resultsChecker"])
    expect(resolveMainMenu({ ...vis, payBills: false }, false, { networkPlans: true, payBills: true }).map(i => i.label))
      .toEqual(["Internet Bundles", "AFA Registration", "Buy Airtime", "Results Checker"])
    expect(resolveMainMenu(vis, false, { networkPlans: false, payBills: true }).map(i => `${i.digit}. ${i.label}`))
      .toEqual(["1. Internet Bundles", "2. AFA Registration", "3. Buy Airtime", "4. Results Checker", "5. Pay Bills"])
    expect(resolveShopMenu(vis, false).map(i => i.key)).toEqual(["internet", "airtime", "resultsChecker"])
    expect(resolveShopMenu(vis, true, { networkPlans: true, payBills: true }).map(i => `${i.digit}. ${i.label}`))
      .toEqual(["1. Internet Bundles", "2. Buy Airtime", "3. Results Checker", "4. Pay Bills"])
  })
  it("the header is the given welcome line", () => {
    const r = resolveMainMenu(allOn, false)
    expect(mainMenuText(r, "Akwaaba to Ama Data")).toBe(
      "Akwaaba to Ama Data\n1. Internet Bundles\n2. AFA Registration\n3. Buy Airtime\n4. Results Checker\n0. Exit"
    )
  })
  it("Internet Bundles is hidden, and the rest renumber, when neither type is visible", () => {
    const vis = { ...allOn, data: false, networkPlans: true, payBills: true }
    expect(resolveMainMenu(vis, false, { networkPlans: false, payBills: true }).map(i => `${i.digit}. ${i.label}`))
      .toEqual(["1. AFA Registration", "2. Buy Airtime", "3. Results Checker", "4. Pay Bills"])
    expect(resolveMainMenu(allOn, true).map(i => i.key)).toEqual(["afa", "airtime", "resultsChecker"])
  })
})

describe("internet bundle types", () => {
  const open = { networkPlans: true, payBills: true }
  const vis = { ...allOn, networkPlans: true, payBills: true }
  it("always in the order data, networkPlans", () => {
    expect(resolveInternetTypes(vis, false, open)).toEqual(["data", "networkPlans"])
  })
  it("data follows admin visibility and the whitelist block; networkPlans follows the visibility flag and the gate", () => {
    expect(resolveInternetTypes(vis, true, open)).toEqual(["networkPlans"])
    expect(resolveInternetTypes({ ...vis, data: false }, false, open)).toEqual(["networkPlans"])
    expect(resolveInternetTypes(vis, false)).toEqual(["data"])
    expect(resolveInternetTypes({ ...vis, networkPlans: false }, false, open)).toEqual(["data"])
    expect(resolveInternetTypes(vis, true)).toEqual([])
  })
  it("the type screen", () => {
    expect(internetMenuText(["data", "networkPlans"])).toBe("Internet Bundles\n1. Data Bundles\n2. Standard Bundles\n0. Back")
    expect(internetMenuText(["networkPlans"])).toBe("Internet Bundles\n1. Standard Bundles\n0. Back")
  })
  it("exit message uses the brand (default Clingshub for an empty brand)", () => {
    expect(mainExitText("Ama Data")).toBe("Thank you for using Ama Data.")
    expect(mainExitText(DEFAULT_BRAND)).toBe("Thank you for using Clingshub.")
    expect(mainExitText("")).toBe("Thank you for using Clingshub.")
  })
  it("the default welcome is 'Welcome to Clingshub'", () => {
    expect(mainMenuText(resolveMainMenu(allOn, false), DEFAULT_WELCOME).split("\n")[0]).toBe("Welcome to Clingshub")
  })
  it("hides Internet Bundles (data only here) when the caller is whitelist-blocked or admin-hidden", () => {
    expect(resolveMainMenu(allOn, true).map(i => i.key)).not.toContain("internet")
    expect(resolveMainMenu({ ...allOn, data: false }, false).map(i => i.key)).not.toContain("internet")
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
  it("network and size, recipient, amount, then the question and 1 Confirm / 0 Cancel", () => {
    expect(confirmMenuText("MTN", "1", 4.5, "0555773910"))
      .toBe("MTN 1GB\nTo: 0555773910\nAmount: GHS 4.50\n\nConfirm your order?\n1. Confirm\n0. Cancel")
    expect(recipientPromptText()).toContain("recipient")
  })
  it("puts the delivery lines under the amount, and drops them if the screen would overflow", () => {
    expect(confirmMenuText("MTN", "1", 4.5, "0555773910", "Delivery Est: 3min\nLast Order Took: 39sec"))
      .toBe("MTN 1GB\nTo: 0555773910\nAmount: GHS 4.50\nDelivery Est: 3min\nLast Order Took: 39sec\n\nConfirm your order?\n1. Confirm\n0. Cancel")
    const long = confirmMenuText("MTN", "1", 4.5, "0555773910", "x".repeat(150))
    expect(long).not.toContain("xxx")
    expect(long).toBe(confirmMenuText("MTN", "1", 4.5, "0555773910"))
  })
  it("asks who the bundle is for, offering the caller's own number", () => {
    expect(whoForText("0555773910")).toBe("Who is this for?\n1. My Self (0555773910)\n2. Someone Else\n0. Back")
  })
})

describe("shop menus", () => {
  const on = { data: true, afa: true, airtime: true, resultsChecker: true }
  it("lists internet bundles, airtime and results checker with real wording; never AFA", () => {
    expect(resolveShopMenu(on, false).map(i => i.label)).toEqual(["Internet Bundles", "Buy Airtime", "Results Checker"])
  })
  it("hides data for a whitelist-blocked caller and each service the admin hides", () => {
    expect(resolveShopMenu(on, true).map(i => i.key)).toEqual(["airtime", "resultsChecker"])
    expect(resolveShopMenu({ ...on, airtime: false }, false).map(i => i.key)).toEqual(["internet", "resultsChecker"])
    expect(resolveShopMenu({ data: false, afa: true, airtime: false, resultsChecker: false }, false)).toEqual([])
  })
  it("shopHeader: printable ASCII, collapsed spaces, max 30 chars, never empty", () => {
    expect(shopHeader("Ama \u{1F31F} Data Hub & More Super Long Name Ltd")).toBe("Ama Data Hub & More Super Long")
    expect(shopHeader("\u{1F31F}\u{1F31F}")).toBe("Shop")
    expect(shopHeader("  Kofi's   Shop ")).toBe("Kofi's Shop")
  })
  it("code prompts", () => {
    expect(shopCodePromptText(DEFAULT_WELCOME)).toBe("Welcome to Clingshub\nEnter shop code:\n0. Exit")
    expect(shopCodePromptText("Akwaaba to Ama Data")).toBe("Akwaaba to Ama Data\nEnter shop code:\n0. Exit")
    expect(shopCodeRetryText("Invalid code. Try again.")).toBe("Invalid code. Try again.\nEnter shop code:\n0. Exit")
  })
  it("product menu text", () => {
    expect(shopMenuText("Ama Data Hub", resolveShopMenu(on, false))).toBe(
      "Ama Data Hub\nWhat would you like to buy?\n1. Internet Bundles\n2. Buy Airtime\n3. Results Checker\n0. Exit"
    )
  })
  it("product menu shows the owner's Helpline under the shop name; none = unchanged", () => {
    expect(shopMenuText("Ama Data Hub", resolveShopMenu(on, false), "0241234567")).toBe(
      "Ama Data Hub\nHelpline: 0241234567\nWhat would you like to buy?\n1. Internet Bundles\n2. Buy Airtime\n3. Results Checker\n0. Exit"
    )
    expect(shopMenuText("Ama Data Hub", resolveShopMenu(on, false), null)).toBe(shopMenuText("Ama Data Hub", resolveShopMenu(on, false)))
  })
  it("the Helpline line fits the 182-char screen with the longest name and every item", () => {
    const all = resolveShopMenu({ ...on, payBills: true }, false, { networkPlans: true, payBills: true })
    const text = shopMenuText("X".repeat(60), all, "0241234567")
    expect(text).toContain("\nHelpline: 0241234567\n")
    expect(text.length).toBeLessThanOrEqual(182)
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
