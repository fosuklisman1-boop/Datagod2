import { describe, it, expect, afterEach } from "vitest"
import { joinShopUrl, shareJoinUrl } from "./join-url"
import { subagentsHostRedirect, SUBAGENTS_SUBDOMAIN } from "./join-host"

const prev = process.env.NEXT_PUBLIC_APP_URL
afterEach(() => {
  if (prev === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = prev
})

describe("joinShopUrl", () => {
  it("is absolute and on the main domain", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://www.datagod.store"
    expect(joinShopUrl("kofi-data")).toBe("https://www.datagod.store/join/shop/kofi-data")
  })

  it("drops a trailing slash on the configured origin", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://www.datagod.store/"
    expect(joinShopUrl("kofi-data")).toBe("https://www.datagod.store/join/shop/kofi-data")
  })

  it("falls back to the production domain when the origin is not configured", () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(joinShopUrl("kofi-data")).toMatch(/^https:\/\/[^/]+\/join\/shop\/kofi-data$/)
  })

  it("encodes the handle so it cannot change the path", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://www.datagod.store"
    expect(joinShopUrl("a/b?c")).toBe("https://www.datagod.store/join/shop/a%2Fb%3Fc")
  })
})

describe("shareJoinUrl", () => {
  it("is the short subagents.<root>/<handle> link", () => {
    expect(shareJoinUrl("kofi-data")).toBe("https://subagents.datagod.store/kofi-data")
  })

  it("uses the same subdomain the middleware redirects, landing on the join page", () => {
    const link = new URL(shareJoinUrl("kofi-data"))
    expect(link.hostname.startsWith(`${SUBAGENTS_SUBDOMAIN}.`)).toBe(true)
    expect(subagentsHostRedirect(link.host, link.pathname, "datagod.store")).toBe("https://www.datagod.store/join/shop/kofi-data")
  })
})
