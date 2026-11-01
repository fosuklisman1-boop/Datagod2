import { describe, it, expect } from "vitest"
import { classifySiteKind, isMainHostName, isMainSiteFromHeaders, parseSiteKind, showsPoweredByFooter } from "./site-kind"

const none = { shopSubdomain: null, customDomain: false }

describe("classifySiteKind", () => {
  it.each(["www.datagod.store", "datagod.store", "WWW.DATAGOD.STORE:443", "localhost:3000", "datagod-git-x.vercel.app"])(
    "main host %s → main",
    (host) => {
      expect(classifySiteKind(host, none)).toBe("main")
    },
  )

  it("shop subdomain → shop", () => {
    expect(classifySiteKind("kofi.datagod.store", { shopSubdomain: "kofi", customDomain: false })).toBe("shop")
    expect(classifySiteKind("kofi.localhost:3000", { shopSubdomain: "kofi", customDomain: false })).toBe("shop")
  })

  it("custom domain → custom, including a wildcard shop label under it", () => {
    expect(classifySiteKind("cheapdata.com", { shopSubdomain: null, customDomain: true })).toBe("custom")
    expect(classifySiteKind("kofi.clingshub.com", { shopSubdomain: null, customDomain: true })).toBe("custom")
  })

  it.each(["app.datagod.store", "admin.datagod.store", "api.datagod.store"])("reserved subdomain %s → custom (not main)", (host) => {
    expect(classifySiteKind(host, none)).toBe("custom")
  })

  it("unmapped foreign host and empty host → custom", () => {
    expect(classifySiteKind("unknown.example", none)).toBe("custom")
    expect(classifySiteKind(null, none)).toBe("custom")
  })
})

describe("parseSiteKind", () => {
  it("accepts the three kinds only", () => {
    expect(parseSiteKind("main")).toBe("main")
    expect(parseSiteKind(" Shop ")).toBe("shop")
    expect(parseSiteKind("custom")).toBe("custom")
    expect(parseSiteKind("www")).toBeNull()
    expect(parseSiteKind("")).toBeNull()
    expect(parseSiteKind(null)).toBeNull()
  })
})

describe("isMainSiteFromHeaders", () => {
  it("trusts x-site-kind over the host", () => {
    // the bug this fixes: a shop subdomain has no x-domain-site-name
    expect(isMainSiteFromHeaders({ siteKind: "shop", host: "kofi.datagod.store", domainSiteName: null })).toBe(false)
    expect(isMainSiteFromHeaders({ siteKind: "custom", host: "cheapdata.com", domainSiteName: "Cheap Data" })).toBe(false)
    expect(isMainSiteFromHeaders({ siteKind: "custom", host: "app.datagod.store" })).toBe(false)
    expect(isMainSiteFromHeaders({ siteKind: "main", host: "www.datagod.store" })).toBe(true)
  })

  it("falls back to the host check (and custom-domain branding) without the header", () => {
    expect(isMainSiteFromHeaders({ siteKind: null, host: "www.datagod.store" })).toBe(true)
    expect(isMainSiteFromHeaders({ siteKind: null, host: "kofi.datagod.store" })).toBe(false)
    expect(isMainSiteFromHeaders({ siteKind: null, host: "admin.datagod.store" })).toBe(false)
    expect(isMainSiteFromHeaders({ siteKind: "bogus", host: "cheapdata.com" })).toBe(false)
    expect(isMainSiteFromHeaders({ siteKind: null, host: "www.datagod.store", domainSiteName: "X" })).toBe(false)
  })
})

describe("isMainHostName", () => {
  it("is the plain host check", () => {
    expect(isMainHostName("www.datagod.store")).toBe(true)
    expect(isMainHostName("myshop.datagod.store")).toBe(false)
  })
})

describe("showsPoweredByFooter", () => {
  it("shows on shop subdomains", () => {
    expect(showsPoweredByFooter("shop")).toBe(true)
    expect(showsPoweredByFooter(" SHOP ")).toBe(true)
  })
  it.each(["custom", "main", null, undefined, "", "bogus"])("hides for %s", (kind) => {
    expect(showsPoweredByFooter(kind)).toBe(false)
  })
})
