import { describe, it, expect } from "vitest"
import { buildRobots, isBlockedRobotsHost } from "./robots"

describe("buildRobots", () => {
  it("main host: canonical sitemap, no crawlDelay, no redundant /shop/ allow", () => {
    const r = buildRobots("www.datagod.store")
    expect(r.sitemap).toBe("https://www.datagod.store/sitemap.xml")
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules]
    const star = rules.find((x) => x.userAgent === "*")!
    expect(star.allow).toBe("/")
    expect(star.crawlDelay).toBeUndefined()
    expect(star.disallow).toContain("/dashboard")
    expect(JSON.stringify(r)).not.toContain("/shop/")
  })

  it("ignores NEXT_PUBLIC_APP_URL", () => {
    const prev = process.env.NEXT_PUBLIC_APP_URL
    process.env.NEXT_PUBLIC_APP_URL = "https://preview.example.com"
    try {
      expect(buildRobots("www.datagod.store").sitemap).toBe("https://www.datagod.store/sitemap.xml")
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_APP_URL
      else process.env.NEXT_PUBLIC_APP_URL = prev
    }
  })

  it.each(["app.datagod.store", "admin.datagod.store", "API.datagod.store:443"])("%s blocks everything", (host) => {
    expect(isBlockedRobotsHost(host)).toBe(true)
    expect(buildRobots(host)).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] })
  })

  it.each(["www.datagod.store", "datagod.store", "kofi.datagod.store", "cheapdata.com", null])("%s is not blocked", (host) => {
    expect(isBlockedRobotsHost(host)).toBe(false)
  })
})
