import { describe, it, expect } from "vitest"
import { TOGGLEABLE_PAGES } from "./custom-domain-pages"

describe("TOGGLEABLE_PAGES", () => {
  it("has no duplicate keys", () => {
    const keys = TOGGLEABLE_PAGES.map(p => p.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("has exactly 20 entries: 3 auth, 6 core, 11 tools", () => {
    expect(TOGGLEABLE_PAGES.filter(p => p.group === "auth")).toHaveLength(3)
    expect(TOGGLEABLE_PAGES.filter(p => p.group === "core")).toHaveLength(6)
    expect(TOGGLEABLE_PAGES.filter(p => p.group === "tools")).toHaveLength(11)
  })

  it("includes exactly the 9 original dealer-tool paths plus the new Developer/API tool", () => {
    const toolPaths = TOGGLEABLE_PAGES
      .filter(p => p.group === "tools" && p.key !== "my_shop")
      .flatMap(p => p.paths ?? [])
    expect(toolPaths.slice().sort()).toEqual([
      "/dashboard/afa-orders",
      "/dashboard/buy-stock",
      "/dashboard/developer",
      "/dashboard/payment-reverify",
      "/dashboard/shop-dashboard",
      "/dashboard/sub-agent-catalog",
      "/dashboard/sub-agents",
      "/dashboard/upgrade",
      "/dashboard/ussd-shop",
    ])
  })

  it("has no paths for the 3 standalone auth-group entries", () => {
    const authEntries = TOGGLEABLE_PAGES.filter(p => p.group === "auth")
    expect(authEntries.map(p => p.key).slice().sort()).toEqual(["guest_purchase", "join_channel", "landing_page"])
    expect(authEntries.every(p => p.paths === undefined)).toBe(true)
  })

  it("wallet has a single path and sits in the core group", () => {
    const wallet = TOGGLEABLE_PAGES.find(p => p.key === "wallet")
    expect(wallet?.paths).toEqual(["/dashboard/wallet"])
    expect(wallet?.group).toBe("core")
  })

  it("the 4 other single-path core keys each have exactly one path", () => {
    const coreKeys = ["my_orders", "transactions", "profile", "complaints"]
    for (const key of coreKeys) {
      const entry = TOGGLEABLE_PAGES.find(p => p.key === key)
      expect(entry?.paths).toHaveLength(1)
    }
  })

  it("dashboard_home has no registered path — it's checked explicitly at its render sites instead, so middleware's path-based redirect never intercepts it", () => {
    const dashboardHome = TOGGLEABLE_PAGES.find(p => p.key === "dashboard_home")
    expect(dashboardHome?.paths).toBeUndefined()
    expect(dashboardHome?.group).toBe("core")
  })

  it("my_shop bundles exactly its 7 routes (Overview + 6 sibling pages) as one unit", () => {
    const myShop = TOGGLEABLE_PAGES.find(p => p.key === "my_shop")
    expect(myShop?.paths?.slice().sort()).toEqual([
      "/dashboard/customers",
      "/dashboard/my-shop",
      "/dashboard/shop-orders",
      "/dashboard/shop-pricing",
      "/dashboard/shop-profile",
      "/dashboard/shop-profit-logs",
      "/dashboard/shop-withdraw",
    ])
  })
})
