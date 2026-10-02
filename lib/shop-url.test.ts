import { describe, it, expect } from "vitest"
import { shopOrigin } from "./shop-url"

describe("shopOrigin", () => {
  it("builds the main-site URL when no linked domain is given", () => {
    expect(shopOrigin("my-shop")).toBe("https://my-shop.datagod.store")
  })

  it("builds the main-site URL when the linked domain is explicitly null", () => {
    expect(shopOrigin("my-shop", null)).toBe("https://my-shop.datagod.store")
  })

  it("builds the custom-domain subdomain URL when a linked domain is given", () => {
    expect(shopOrigin("my-shop", "clingshub.com")).toBe("https://my-shop.clingshub.com")
  })
})
