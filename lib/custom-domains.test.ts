import { describe, it, expect } from "vitest"
import {
  getServiceRedirect,
  getServicePrimaryPath,
  isPathAllowedForService,
  normalizeDomainHost,
  hexToHslTriplet,
  isReservedDomainHost,
  isPageHidden,
} from "./custom-domains"

const ALL_DEALER_TOOL_KEYS = [
  "afa_orders", "upgrade", "my_shop", "shop_dashboard", "sub_agents",
  "sub_agent_catalog", "ussd_shop", "payment_reverify", "buy_stock",
]

describe("getServicePrimaryPath", () => {
  it("returns each service's own first/primary path", () => {
    expect(getServicePrimaryPath("data_bundles")).toBe("/dashboard/data-packages")
    expect(getServicePrimaryPath("airtime")).toBe("/dashboard/airtime")
    expect(getServicePrimaryPath("results_checker")).toBe("/dashboard/results-checker")
    expect(getServicePrimaryPath("bulk_sms")).toBe("/dashboard/sms")
  })
})

describe("getServiceRedirect", () => {
  it("returns null for a path belonging to one of the domain's selected services", () => {
    expect(getServiceRedirect("/dashboard/data-packages", ["data_bundles"], [])).toBeNull()
    expect(getServiceRedirect("/dashboard/data-packages/foo", ["data_bundles"], [])).toBeNull()
    expect(getServiceRedirect("/dashboard/airtime", ["data_bundles", "airtime"], [])).toBeNull()
  })

  it("returns null instead of throwing for an unrecognized service value", () => {
    expect(getServiceRedirect("/dashboard/airtime", ["not_a_real_service" as any], [])).toBeNull()
  })

  it("returns null for account-wide paths regardless of selected services", () => {
    expect(getServiceRedirect("/dashboard/wallet", ["airtime"], [])).toBeNull()
    expect(getServiceRedirect("/dashboard/my-orders", ["bulk_sms"], [])).toBeNull()
    expect(getServiceRedirect("/dashboard/profile", ["results_checker"], [])).toBeNull()
    expect(getServiceRedirect("/dashboard/transactions", ["airtime"], [])).toBeNull()
    expect(getServiceRedirect("/dashboard/complaints", ["airtime"], [])).toBeNull()
    expect(getServiceRedirect("/dashboard", ["airtime"], [])).toBeNull()
    expect(getServiceRedirect("/admin/users", ["data_bundles"], [])).toBeNull()
  })

  it("redirects a path belonging to a non-selected service to the first selected service's root", () => {
    expect(getServiceRedirect("/dashboard/airtime", ["data_bundles"], [])).toBe("/dashboard/data-packages")
    expect(getServiceRedirect("/dashboard/data-packages", ["airtime"], [])).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/sms", ["results_checker"], [])).toBe("/dashboard/results-checker")
    expect(getServiceRedirect("/dashboard/results-checker", ["airtime", "bulk_sms"], [])).toBe("/dashboard/airtime")
  })

  it("treats both results-checker and results-check paths as the results_checker service", () => {
    expect(getServiceRedirect("/dashboard/results-checker", ["results_checker"], [])).toBeNull()
    expect(getServiceRedirect("/dashboard/results-check", ["results_checker"], [])).toBeNull()
    expect(getServiceRedirect("/dashboard/results-checker", ["bulk_sms"], [])).toBe("/dashboard/sms")
  })

  it("returns null when given an empty services array (defensive — treated as unrestricted)", () => {
    expect(getServiceRedirect("/dashboard/airtime", [], [])).toBeNull()
  })

  it("redirects dealer/business-management paths to the first selected service when those pages are hidden", () => {
    expect(getServiceRedirect("/dashboard/afa-orders", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/upgrade", ["data_bundles"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/data-packages")
    expect(getServiceRedirect("/dashboard/my-shop", ["data_bundles"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/data-packages")
    expect(getServiceRedirect("/dashboard/my-shop/settings", ["data_bundles"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/data-packages")
    expect(getServiceRedirect("/dashboard/shop-dashboard", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/sub-agents", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/sub-agent-catalog", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/sub-agent-catalog/add", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/ussd-shop", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/payment-reverify", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/buy-stock", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/airtime")
  })

  it("does NOT redirect a dealer-tool path when its key is not in hiddenPages (admin has shown it)", () => {
    expect(getServiceRedirect("/dashboard/my-shop", ["airtime"], [])).toBeNull()
    expect(getServiceRedirect("/dashboard/upgrade", ["airtime"], ["afa_orders"])).toBeNull()
  })

  it("redirects /dashboard/wallet when wallet is hidden, and allows it again once it's not — the first non-dealer-tool key with a path", () => {
    expect(getServiceRedirect("/dashboard/wallet", ["airtime"], ["wallet"])).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/wallet", ["airtime"], [])).toBeNull()
  })

  it("hiding my_shop blocks all 7 of its bundled paths, not just /dashboard/my-shop", () => {
    expect(getServiceRedirect("/dashboard/my-shop", ["airtime"], ["my_shop"])).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/shop-orders", ["airtime"], ["my_shop"])).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/customers", ["airtime"], ["my_shop"])).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/shop-profit-logs", ["airtime"], ["my_shop"])).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/shop-pricing", ["airtime"], ["my_shop"])).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/shop-withdraw", ["airtime"], ["my_shop"])).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/shop-profile", ["airtime"], ["my_shop"])).toBe("/dashboard/airtime")
  })

  it("does not block my_shop's paths when my_shop is not in hiddenPages", () => {
    expect(getServiceRedirect("/dashboard/shop-pricing", ["airtime"], [])).toBeNull()
  })

  it("hiding dashboard_home blocks only the exact /dashboard root, not its sibling dashboard pages", () => {
    expect(getServiceRedirect("/dashboard", ["airtime"], ["dashboard_home"])).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/wallet", ["airtime"], ["dashboard_home"])).toBeNull()
    expect(getServiceRedirect("/dashboard/my-shop", ["airtime"], ["dashboard_home"])).toBeNull()
  })

  it("does not redirect dealer/business-management paths when service is null (main site), regardless of hiddenPages", () => {
    expect(isPathAllowedForService("/dashboard/my-shop", null, ALL_DEALER_TOOL_KEYS)).toBe(true)
    expect(isPathAllowedForService("/dashboard/sub-agents", null, ALL_DEALER_TOOL_KEYS)).toBe(true)
  })
})

describe("isPathAllowedForService", () => {
  it("allows everything when services is null (main site/shop)", () => {
    expect(isPathAllowedForService("/dashboard/airtime", null, [])).toBe(true)
    expect(isPathAllowedForService("/dashboard/sms", null, [])).toBe(true)
    expect(isPathAllowedForService("/dashboard/my-shop", null, [])).toBe(true)
  })

  it("allows selected-service and account-wide paths", () => {
    expect(isPathAllowedForService("/dashboard/airtime", ["airtime"], [])).toBe(true)
    expect(isPathAllowedForService("/dashboard/wallet", ["airtime"], [])).toBe(true)
    expect(isPathAllowedForService("/dashboard/data-packages", ["data_bundles", "airtime"], [])).toBe(true)
    expect(isPathAllowedForService("/dashboard/airtime", ["data_bundles", "airtime"], [])).toBe(true)
  })

  it("disallows a non-selected service's path", () => {
    expect(isPathAllowedForService("/dashboard/sms", ["airtime"], [])).toBe(false)
    expect(isPathAllowedForService("/dashboard/sms", ["airtime", "data_bundles"], [])).toBe(false)
  })

  it("disallows dealer/business-management paths on a branded domain when they're hidden", () => {
    expect(isPathAllowedForService("/dashboard/my-shop", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe(false)
    expect(isPathAllowedForService("/dashboard/afa-orders", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe(false)
    expect(isPathAllowedForService("/dashboard/upgrade", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe(false)
  })

  it("allows a dealer-tool path once it's no longer in hiddenPages", () => {
    expect(isPathAllowedForService("/dashboard/my-shop", ["airtime"], [])).toBe(true)
  })
})

describe("normalizeDomainHost", () => {
  it("lowercases and strips the port", () => {
    expect(normalizeDomainHost("CheckResults.com:3000")).toBe("checkresults.com")
  })

  it("returns null for a null host", () => {
    expect(normalizeDomainHost(null)).toBeNull()
  })
})

describe("hexToHslTriplet", () => {
  it("converts pure red", () => {
    expect(hexToHslTriplet("#FF0000")).toBe("0 100% 50%")
  })
  it("converts pure green", () => {
    expect(hexToHslTriplet("#00FF00")).toBe("120 100% 50%")
  })
  it("converts pure blue", () => {
    expect(hexToHslTriplet("#0000FF")).toBe("240 100% 50%")
  })
  it("converts white", () => {
    expect(hexToHslTriplet("#FFFFFF")).toBe("0 0% 100%")
  })
  it("converts black", () => {
    expect(hexToHslTriplet("#000000")).toBe("0 0% 0%")
  })
  it("converts mid-gray", () => {
    expect(hexToHslTriplet("#808080")).toBe("0 0% 50%")
  })
  it("accepts a hex without a leading #", () => {
    expect(hexToHslTriplet("FF0000")).toBe("0 100% 50%")
  })
  it("returns null for malformed input", () => {
    expect(hexToHslTriplet("not-a-color")).toBeNull()
    expect(hexToHslTriplet("#12")).toBeNull()
    expect(hexToHslTriplet("")).toBeNull()
  })
})

describe("isReservedDomainHost", () => {
  it("rejects the exact root domain", () => {
    expect(isReservedDomainHost("datagod.store", "datagod.store")).toBe(true)
  })
  it("rejects any single-label subdomain of the root domain", () => {
    expect(isReservedDomainHost("my-shop.datagod.store", "datagod.store")).toBe(true)
    expect(isReservedDomainHost("www.datagod.store", "datagod.store")).toBe(true)
  })
  it("is case-insensitive", () => {
    expect(isReservedDomainHost("DataGod.Store", "datagod.store")).toBe(true)
  })
  it("allows an unrelated custom domain", () => {
    expect(isReservedDomainHost("checkresults.com", "datagod.store")).toBe(false)
  })
  it("does not false-positive on a lookalike domain that merely shares trailing letters", () => {
    expect(isReservedDomainHost("notdatagod.store", "datagod.store")).toBe(false)
  })
})

describe("isPageHidden", () => {
  it("returns true when the key is in hiddenPages", () => {
    expect(isPageHidden("landing_page", ["landing_page", "wallet"])).toBe(true)
  })

  it("returns false when the key is not in hiddenPages", () => {
    expect(isPageHidden("landing_page", ["wallet"])).toBe(false)
  })

  it("returns false for an empty hiddenPages array", () => {
    expect(isPageHidden("wallet", [])).toBe(false)
  })
})
