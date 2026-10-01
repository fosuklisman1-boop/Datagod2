import { describe, it, expect } from "vitest"
import { pickFirstVisiblePath } from "./dashboard-nav-items"

// NOTE on `services`: lib/custom-domains.ts's isPathAllowedForService/
// getServiceRedirect treat `services === null` OR `services === []` as
// "unrestricted — allow everything, including every hidden_pages entry".
// That's correct for the real main site (no custom domain row at all), but
// it means a test that wants hiddenPages to actually take effect MUST pass
// a concrete, non-empty services array — exactly like a real custom domain
// always has at least one service selected. Passing `null` anywhere below
// except the explicit "main site" test would silently make the hiddenPages
// argument a no-op and prove nothing.

describe("pickFirstVisiblePath", () => {
  it("returns the first menuItem for the main site (services null, nothing hidden)", () => {
    expect(pickFirstVisiblePath("user", null, [], false)).toBe("/dashboard")
  })

  it("skips a hidden dashboard_home and returns the next role-eligible, non-hidden item", () => {
    const allServices = ["data_bundles", "airtime", "results_checker", "bulk_sms"]
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

  it("hiding my_shop skips all 7 of its bundled routes, landing on the next distinct reachable item", () => {
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

  it("returns null for a null role (not yet loaded / signed out)", () => {
    expect(pickFirstVisiblePath(null, null, [], false)).toBeNull()
  })
})
