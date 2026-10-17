import { shopPreviewDescription, shopPreviewImage } from "@/lib/shop-link-preview"

const base = { shop_name: "Kofi Data" }

describe("shopPreviewDescription", () => {
  it("uses the shop's own description", () => {
    expect(shopPreviewDescription({ ...base, description: "Cheap MTN bundles" }, "fallback")).toBe("Cheap MTN bundles")
  })

  it("trims surrounding whitespace", () => {
    expect(shopPreviewDescription({ ...base, description: "  Cheap bundles \n" }, "fallback")).toBe("Cheap bundles")
  })

  it("falls back when the description is missing or blank", () => {
    expect(shopPreviewDescription(base, "fallback")).toBe("fallback")
    expect(shopPreviewDescription({ ...base, description: null }, "fallback")).toBe("fallback")
    expect(shopPreviewDescription({ ...base, description: "   " }, "fallback")).toBe("fallback")
  })
})

describe("shopPreviewImage", () => {
  it("prefers the logo over the banner, as a thumbnail card with no faked size", () => {
    expect(shopPreviewImage({ ...base, logo_url: "https://cdn/logo.png", banner_url: "https://cdn/banner.png" })).toEqual({
      url: "https://cdn/logo.png",
      card: "summary",
    })
  })

  it("uses the banner when there is no logo", () => {
    expect(shopPreviewImage({ ...base, logo_url: "  ", banner_url: "https://cdn/banner.png" })).toEqual({
      url: "https://cdn/banner.png",
      card: "summary_large_image",
    })
  })

  it("falls back to the platform image when the shop has neither", () => {
    expect(shopPreviewImage({ ...base, logo_url: null, banner_url: null })).toEqual({
      url: "https://www.datagod.store/og-image.png",
      width: 1200,
      height: 630,
      card: "summary_large_image",
    })
  })
})
