import { describe, it, expect } from "vitest"
import {
  getServiceRedirect,
  isPathAllowedForService,
  normalizeDomainHost,
  hexToHslTriplet,
  isReservedDomainHost,
} from "./custom-domains"

describe("getServiceRedirect", () => {
  it("returns null for a path belonging to the domain's own service", () => {
    expect(getServiceRedirect("/dashboard/data-packages", "data_bundles")).toBeNull()
    expect(getServiceRedirect("/dashboard/data-packages/foo", "data_bundles")).toBeNull()
  })

  it("returns null for account-wide paths regardless of service", () => {
    expect(getServiceRedirect("/dashboard/wallet", "airtime")).toBeNull()
    expect(getServiceRedirect("/dashboard/my-orders", "bulk_sms")).toBeNull()
    expect(getServiceRedirect("/dashboard/profile", "results_checker")).toBeNull()
    expect(getServiceRedirect("/admin/users", "data_bundles")).toBeNull()
  })

  it("redirects a path belonging to a different service to the domain's own service root", () => {
    expect(getServiceRedirect("/dashboard/airtime", "data_bundles")).toBe("/dashboard/data-packages")
    expect(getServiceRedirect("/dashboard/data-packages", "airtime")).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/sms", "results_checker")).toBe("/dashboard/results-checker")
  })

  it("treats both results-checker and results-check paths as the results_checker service", () => {
    expect(getServiceRedirect("/dashboard/results-checker", "results_checker")).toBeNull()
    expect(getServiceRedirect("/dashboard/results-check", "results_checker")).toBeNull()
    expect(getServiceRedirect("/dashboard/results-checker", "bulk_sms")).toBe("/dashboard/sms")
  })
})

describe("isPathAllowedForService", () => {
  it("allows everything when service is null (main site/shop)", () => {
    expect(isPathAllowedForService("/dashboard/airtime", null)).toBe(true)
    expect(isPathAllowedForService("/dashboard/sms", null)).toBe(true)
  })

  it("allows own-service and account-wide paths", () => {
    expect(isPathAllowedForService("/dashboard/airtime", "airtime")).toBe(true)
    expect(isPathAllowedForService("/dashboard/wallet", "airtime")).toBe(true)
  })

  it("disallows another service's path", () => {
    expect(isPathAllowedForService("/dashboard/sms", "airtime")).toBe(false)
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
