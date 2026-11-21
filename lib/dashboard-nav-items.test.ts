import { describe, it, expect } from "vitest"
import {
  pickFirstVisiblePath as pickRaw, isNavActive, menuItems, shopItems, menuGroups, adminNavItems, adminNavGroups,
} from "./dashboard-nav-items"
import type { DomainService } from "./custom-domains"
import { ALL_CAPABILITIES, navVisible, type RoleRights } from "./roles/capabilities"

const ALL_SET: RoleRights = { kind: "set", caps: new Set(ALL_CAPABILITIES) }
const rightsOf = (slug: string): RoleRights =>
  slug === "admin" ? { kind: "all" } : slug === "sub_agent" ? { kind: "sub_agent" } : ALL_SET
// Same arguments as before the capability change: user/dealer hold every capability.
const pickFirstVisiblePath = (
  role: string | null, services: DomainService[] | null, hidden: string[], sub: boolean,
) => pickRaw(role, role ? rightsOf(role) : { kind: "set", caps: new Set() }, services, hidden, sub)

// Frozen copy of the hard-coded `roles` arrays before nav moved onto capabilities (2026-11-19).
const U = "user", A = "admin", D = "dealer", S = "sub_agent"
const LEGACY_NAV_ROLES: Record<string, string[]> = {
  "/dashboard": [U, A, D],
  "/dashboard/data-packages": [U, A, D],
  "/dashboard/standard-bundles": [U, A, D, S],
  "/dashboard/airtime": [U, A, D],
  "/dashboard/bills": [U, A, D, S],
  "/dashboard/broadband": [U, A, D, S],
  "/dashboard/results-checker": [U, A, D, S],
  "/dashboard/results-check": [U, A, D, S],
  "/dashboard/my-orders": [U, A, D],
  "/dashboard/afa-orders": [U, A, D],
  "/dashboard/wallet": [U, A, S, D],
  "/dashboard/transactions": [U, A, D],
  "/dashboard/top-performers": [U, A, S, D],
  "/dashboard/profile": [U, A, S, D],
  "/dashboard/developer": [U, A, S, D],
  "/dashboard/complaints": [U, A, D],
  "/dashboard/upgrade": [U, A, D],
  "/dashboard/my-shop": [U, A, S, D],
  "/dashboard/shop-orders": [U, A, S, D],
  "/dashboard/customers": [U, A, S, D],
  "/dashboard/text-orders": [U, A, S, D],
  "/dashboard/blocked-numbers": [U, A, S, D],
  "/dashboard/shop-profit-logs": [U, A, S, D],
  "/dashboard/shop-pricing": [U, A, S, D],
  "/dashboard/sms": [U, A, S, D],
  "/dashboard/shop-withdraw": [U, A, S, D],
  "/dashboard/shop-profile": [U, A, S, D],
  "/dashboard/ussd-shop": [U, A, S, D],
  "/dashboard/payment-reverify": [U, A, S, D],
  "/dashboard/sub-agents": [U, A, D],
  "/dashboard/sub-agent-catalog": [U, A, D],
  "/dashboard/buy-stock": [S],
}

describe("nav visibility by capability", () => {
  const items = [...menuItems, ...shopItems]
  const visible = (slug: string, rights: RoleRights) =>
    items.filter((i) => navVisible(i, slug, rights)).map((i) => i.href).sort()

  it("nav parity: for user, dealer, sub_agent and admin the visible hrefs equal the pre-change roles arrays", () => {
    expect(items.map((i) => i.href).sort()).toEqual(Object.keys(LEGACY_NAV_ROLES).sort())
    for (const slug of [U, D, S, A]) {
      const expected = Object.entries(LEGACY_NAV_ROLES).filter(([, r]) => r.includes(slug)).map(([h]) => h).sort()
      expect(visible(slug, rightsOf(slug)), slug).toEqual(expected)
    }
  })

  it("a custom role with all capabilities sees exactly what dealer sees", () => {
    expect(visible("custom", ALL_SET)).toEqual(visible("dealer", ALL_SET))
  })

  it("a custom role with none sees only /dashboard, /dashboard/profile, /dashboard/complaints", () => {
    expect(visible("custom", { kind: "set", caps: new Set() })).toEqual(
      ["/dashboard", "/dashboard/complaints", "/dashboard/profile"],
    )
  })

  it("a custom role never sees buy-stock, even with every capability", () => {
    expect(visible("custom", ALL_SET)).not.toContain("/dashboard/buy-stock")
  })
})

// NOTE on `services`: lib/custom-domains.ts's isPathAllowedForService/
// getServiceRedirect treat `services === null` OR `services === []` as
// "unrestricted — allow everything, including every hidden_pages entry".
// That's correct for the real main site (no custom domain row at all), but
// it means a test that wants hiddenPages to actually take effect MUST pass
// a concrete, non-empty services array — exactly like a real custom domain
// always has at least one service selected. Passing `null` anywhere below
// except the explicit "main site" test would silently make the hiddenPages
// argument a no-op and prove nothing.

describe("pickFirstVisiblePath with a custom role", () => {
  it("a custom role holding only buy.airtime lands on /dashboard/airtime", () => {
    const rights: RoleRights = { kind: "set", caps: new Set(["buy.airtime"]) }
    // /dashboard (no cap) is hidden here, as on a domain that hides dashboard_home.
    expect(pickRaw("custom", rights, null, ["dashboard_home"], false)).toBe("/dashboard/airtime")
  })
})

describe("pickFirstVisiblePath", () => {
  it("returns the first menuItem for the main site (services null, nothing hidden)", () => {
    expect(pickFirstVisiblePath("user", null, [], false)).toBe("/dashboard")
  })

  it("skips a hidden dashboard_home and returns the next role-eligible, non-hidden item", () => {
    const allServices: DomainService[] = ["data_bundles", "airtime", "results_checker", "bulk_sms"]
    expect(pickFirstVisiblePath("user", allServices, ["dashboard_home"], false)).toBe("/dashboard/data-packages")
  })

  it("respects role membership — a sub_agent lands on wallet, not on a results-checker page this domain doesn't even sell", () => {
    // services: ["data_bundles"] excludes results_checker, so
    // results-checker/results-check (the only sub_agent-eligible menuItems
    // ahead of wallet) are services-blocked, same as a real domain that
    // only sells data bundles.
    expect(pickFirstVisiblePath("sub_agent", ["data_bundles"], [], false)).toBe("/dashboard/wallet")
  })

  it("the dealer-subscription special case: a dealer with no active subscription skips Upgrade and lands on the next reachable item", () => {
    // services: ["bulk_sms"] is the one single-service selection that
    // excludes all 4 of menuItems' own services-gated paths (data-packages/
    // airtime/results-checker/results-check) — bulk_sms's own page,
    // /dashboard/sms, lives in shopItems, not menuItems — so this cleanly
    // isolates the hidden_pages-only items in between, same trick the
    // my_shop-bundle test below reuses.
    const hideEverythingBeforeUpgrade = [
      "dashboard_home", "my_orders", "afa_orders", "wallet", "transactions",
      "profile", "developer", "complaints",
    ]
    expect(pickFirstVisiblePath("dealer", ["bulk_sms"], hideEverythingBeforeUpgrade, false)).toBe("/dashboard/my-shop")
  })

  it("Upgrade IS reachable for a dealer who has an active subscription, once everything ahead of it is hidden", () => {
    const hideEverythingBeforeUpgrade = [
      "dashboard_home", "my_orders", "afa_orders", "wallet", "transactions",
      "profile", "developer", "complaints",
    ]
    expect(pickFirstVisiblePath("dealer", ["bulk_sms"], hideEverythingBeforeUpgrade, true)).toBe("/dashboard/upgrade")
  })

  it("hiding my_shop skips all 8 of its bundled routes, landing on the next distinct reachable item", () => {
    // services: ["data_bundles"] excludes bulk_sms, so shopItems' own
    // /dashboard/sms entry (not part of the my_shop bundle) is blocked for
    // an unrelated reason — proving the walk lands on /dashboard/ussd-shop
    // specifically because all 7 my_shop paths were skipped as one unit,
    // not because of where /dashboard/sms happens to sit in the list.
    const hidden = ["wallet", "profile", "developer", "my_shop"]
    expect(pickFirstVisiblePath("sub_agent", ["data_bundles"], hidden, false)).toBe("/dashboard/ussd-shop")
  })

  it("returns null when every reachable item for this role is hidden or services-gated away", () => {
    const hidden = [
      "wallet", "profile", "developer", "my_shop", "ussd_shop", "payment_reverify", "buy_stock",
    ]
    // services: ["data_bundles"] — sub_agent has no role access to
    // data-packages/airtime anyway, and results-checker/results-check are
    // services-blocked (results_checker not selected); every other
    // sub_agent-reachable item is in `hidden`.
    expect(pickFirstVisiblePath("sub_agent", ["data_bundles"], hidden, false)).toBeNull()
  })

  it("never lands on Top Performers, even when it is the only page left", () => {
    const hidden = [
      "wallet", "profile", "developer", "my_shop", "ussd_shop", "payment_reverify", "buy_stock",
    ]
    expect(menuItems.some((i) => i.href === "/dashboard/top-performers" && i.subAgent === true)).toBe(true)
    expect(pickFirstVisiblePath("sub_agent", ["data_bundles"], hidden, false)).not.toBe("/dashboard/top-performers")
  })

  it("returns null for a null role (not yet loaded / signed out)", () => {
    expect(pickFirstVisiblePath(null, null, [], false)).toBeNull()
  })
})

describe("menuItems labels", () => {
  it("labels the complaints entry Support & Complaints", () => {
    const item = menuItems.find((i) => i.href === "/dashboard/complaints")
    expect(item?.label).toBe("Support & Complaints")
  })
})

describe("sidebar groups", () => {
  it("every grouped menu item points at a real menu group", () => {
    const ids = new Set(menuGroups.map(g => g.id))
    for (const item of menuItems) if (item.group) expect(ids.has(item.group), item.href).toBe(true)
  })

  it("the admin list still has every link the hand-written sidebar had (2026-11-16), once each", () => {
    const before = [
      "/admin", "/admin/ai-assistant", "/admin/airtime", "/admin/airtime/settings", // ai-settings + ai-knowledge merged into ai-assistant 2026-11-21
      "/admin/api-keys", "/admin/blocked-numbers", "/admin/custom-domains", "/admin/gateway",
      "/admin/hubtel-commission", "/admin/leaderboard", "/admin/momo-claims", "/admin/mtn-registration",
      "/admin/orders", "/admin/payment-attempts", "/admin/payment-reverify", "/admin/phone-verification",
      "/admin/rate-limits", "/admin/refunds", "/admin/results-checker", "/admin/results-check-requests",
      "/admin/scheduled-tasks", "/admin/security", "/admin/settings", "/admin/settings/mtn", "/admin/sms",
      "/admin/sms-centre", "/admin/sms-health", "/admin/subscribers", "/admin/subscriptions",
      "/admin/text-to-buy", "/admin/transactions", "/admin/user-phone-audit", "/admin/ussd-hubtel",
      "/admin/ussd-shops", "/admin/utility-bills", "/admin/whatsapp", "/admin/withdrawal-history",
      "/admin/roles", // added 2026-11-19 (roles hub)
    ]
    const hrefs = adminNavItems.map(i => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
    expect([...hrefs].sort()).toEqual([...before].sort())
  })

  it("every admin item points at a real admin group", () => {
    const ids = new Set(adminNavGroups.map(g => g.id))
    for (const item of adminNavItems) expect(ids.has(item.group), item.href).toBe(true)
  })
})

describe("isNavActive", () => {
  it("matches exactly", () => {
    expect(isNavActive("/dashboard/airtime", "/dashboard/airtime")).toBe(true)
    expect(isNavActive("/dashboard/wallet", "/dashboard/airtime")).toBe(false)
  })
  it("keeps SMS active on its sub-routes only", () => {
    expect(isNavActive("/dashboard/sms/compose", "/dashboard/sms")).toBe(true)
    expect(isNavActive("/dashboard/smsx", "/dashboard/sms")).toBe(false)
  })
  it("does not prefix-match other items", () => {
    expect(isNavActive("/dashboard/airtime/foo", "/dashboard/airtime")).toBe(false)
    expect(isNavActive("/dashboard/sms", "/dashboard")).toBe(false)
  })
})
