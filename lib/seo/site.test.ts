import { describe, it, expect, vi, beforeEach } from "vitest"

const headerValues = vi.hoisted(() => ({ current: {} as Record<string, string> }))
vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerValues.current),
}))

import { SITE_URL, absoluteUrl, isMainSiteHost, isMainSiteRequest } from "./site"

describe("isMainSiteHost", () => {
  it.each([
    "www.datagod.store",
    "datagod.store",
    "WWW.DATAGOD.STORE:443",
    "localhost:3000",
    "127.0.0.1:3000",
    "datagod-git-x.vercel.app",
  ])("treats %s as the main site", (host) => {
    expect(isMainSiteHost(host)).toBe(true)
  })

  it.each([
    "myshop.datagod.store",
    "a.b.datagod.store",
    "cheapdata.com",
    "app.datagod.store",
    "admin.datagod.store",
    "api.datagod.store",
    null,
    "",
  ])("rejects %s", (host) => {
    expect(isMainSiteHost(host)).toBe(false)
  })

  it("honours a custom root domain", () => {
    expect(isMainSiteHost("www.example.com", "example.com")).toBe(true)
    expect(isMainSiteHost("shop.example.com", "example.com")).toBe(false)
  })
})

describe("isMainSiteHost with x-site-kind", () => {
  it("lets the middleware's kind decide when it is given", () => {
    expect(isMainSiteHost("www.datagod.store", undefined, "main")).toBe(true)
    expect(isMainSiteHost("kofi.datagod.store", undefined, "shop")).toBe(false)
    expect(isMainSiteHost("cheapdata.com", undefined, "custom")).toBe(false)
    expect(isMainSiteHost("app.datagod.store", undefined, "custom")).toBe(false)
  })
})

describe("isMainSiteRequest", () => {
  beforeEach(() => {
    headerValues.current = {}
  })

  it("main host", async () => {
    headerValues.current = { host: "www.datagod.store", "x-site-kind": "main" }
    expect(await isMainSiteRequest()).toBe(true)
  })

  it("shop subdomain (no x-domain-site-name) is not main", async () => {
    headerValues.current = { host: "kofi.datagod.store", "x-site-kind": "shop" }
    expect(await isMainSiteRequest()).toBe(false)
  })

  it("custom domain is not main", async () => {
    headerValues.current = { host: "cheapdata.com", "x-site-kind": "custom", "x-domain-site-name": "Cheap Data" }
    expect(await isMainSiteRequest()).toBe(false)
  })

  it("reserved subdomain is not main", async () => {
    headerValues.current = { host: "admin.datagod.store", "x-site-kind": "custom" }
    expect(await isMainSiteRequest()).toBe(false)
  })

  it("falls back to the host when the header is missing", async () => {
    headerValues.current = { host: "www.datagod.store" }
    expect(await isMainSiteRequest()).toBe(true)
    headerValues.current = { host: "kofi.datagod.store" }
    expect(await isMainSiteRequest()).toBe(false)
  })
})

describe("absoluteUrl", () => {
  it("builds absolute urls", () => {
    expect(SITE_URL).toBe("https://www.datagod.store")
    expect(absoluteUrl("/mtn-data")).toBe("https://www.datagod.store/mtn-data")
    expect(absoluteUrl("/")).toBe(SITE_URL)
    expect(absoluteUrl("mtn-data")).toBe(absoluteUrl("/mtn-data"))
  })
})
