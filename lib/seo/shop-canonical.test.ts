import { describe, it, expect, vi } from "vitest"
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/custom-domain-lookup", () => ({ resolveCustomDomain: async () => null }))
import { shopCanonicalBase, shopCanonicalUrl } from "./shop-canonical"

describe("shop canonical", () => {
  it("uses the subdomain under the root domain, or under the custom domain serving it", () => {
    expect(shopCanonicalBase({ subdomain: "kofi", shop_slug: "kofi-data" }, null, "datagod.store")).toBe("https://kofi.datagod.store")
    expect(shopCanonicalBase({ subdomain: "kofi", shop_slug: "kofi-data" }, "clingshub.com", "datagod.store")).toBe("https://kofi.clingshub.com")
  })
  it("falls back to /shop/<slug> on www for shops without a subdomain", () => {
    expect(shopCanonicalBase({ subdomain: null, shop_slug: "old" }, null, "datagod.store")).toBe("https://www.datagod.store/shop/old")
  })
  it("appends a subpage path", () => {
    expect(shopCanonicalUrl("https://kofi.datagod.store", "/afa")).toBe("https://kofi.datagod.store/afa")
    expect(shopCanonicalUrl("https://kofi.datagod.store", "airtime")).toBe("https://kofi.datagod.store/airtime")
    expect(shopCanonicalUrl("https://kofi.datagod.store", "/")).toBe("https://kofi.datagod.store")
  })
})
