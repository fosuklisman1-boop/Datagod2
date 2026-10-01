import { describe, it, expect } from "vitest"
import { TOGGLEABLE_PAGES } from "./custom-domain-pages"

describe("TOGGLEABLE_PAGES", () => {
  it("has no duplicate keys", () => {
    const keys = TOGGLEABLE_PAGES.map(p => p.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("includes exactly the 9 dealer-tool paths previously hardcoded in NON_SERVICE_GATED_PATHS", () => {
    const dealerToolPaths = TOGGLEABLE_PAGES
      .filter(p => p.group === "dashboard" && p.key !== "wallet")
      .map(p => p.path)
    expect(dealerToolPaths.slice().sort()).toEqual([
      "/dashboard/afa-orders",
      "/dashboard/buy-stock",
      "/dashboard/my-shop",
      "/dashboard/payment-reverify",
      "/dashboard/shop-dashboard",
      "/dashboard/sub-agent-catalog",
      "/dashboard/sub-agents",
      "/dashboard/upgrade",
      "/dashboard/ussd-shop",
    ])
  })

  it("has no path for the 3 standalone auth-group entries", () => {
    const authEntries = TOGGLEABLE_PAGES.filter(p => p.group === "auth")
    expect(authEntries.map(p => p.key).slice().sort()).toEqual(["guest_purchase", "join_channel", "landing_page"])
    expect(authEntries.every(p => p.path === undefined)).toBe(true)
  })

  it("wallet has both a path and sits in the dashboard group", () => {
    const wallet = TOGGLEABLE_PAGES.find(p => p.key === "wallet")
    expect(wallet?.path).toBe("/dashboard/wallet")
    expect(wallet?.group).toBe("dashboard")
  })
})
