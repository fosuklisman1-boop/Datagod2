import { describe, it, expect } from "vitest"
import { SITE_URL, absoluteUrl, isMainSiteHost } from "./site"

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

describe("absoluteUrl", () => {
  it("builds absolute urls", () => {
    expect(SITE_URL).toBe("https://www.datagod.store")
    expect(absoluteUrl("/mtn-data")).toBe("https://www.datagod.store/mtn-data")
    expect(absoluteUrl("/")).toBe(SITE_URL)
    expect(absoluteUrl("mtn-data")).toBe(absoluteUrl("/mtn-data"))
  })
})
