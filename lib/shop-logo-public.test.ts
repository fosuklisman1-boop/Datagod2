import { describe, it, expect } from "vitest"
import { parseImageDataUri, shopLogoPublicUrl } from "./shop-logo-public"

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

describe("parseImageDataUri", () => {
  it("decodes a base64 png data URI", () => {
    const r = parseImageDataUri(`data:image/png;base64,${PNG_B64}`)
    expect(r?.contentType).toBe("image/png")
    expect(r?.bytes.length).toBe(Buffer.from(PNG_B64, "base64").length)
    expect(r?.bytes[0]).toBe(0x89)
  })

  it("accepts jpeg, webp and gif by their real file signatures (label case ignored)", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString("base64")
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")]).toString("base64")
    const gif = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1").toString("base64")
    expect(parseImageDataUri(`data:IMAGE/JPEG;base64,${jpeg}`)?.contentType).toBe("image/jpeg")
    expect(parseImageDataUri(`data:image/webp;base64,${webp}`)?.contentType).toBe("image/webp")
    expect(parseImageDataUri(`data:image/gif;base64,${gif}`)?.contentType).toBe("image/gif")
  })

  it("serves the REAL type when the label lies (e.g. webp bytes labelled png)", () => {
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")]).toString("base64")
    expect(parseImageDataUri(`data:image/png;base64,${webp}`)?.contentType).toBe("image/webp")
  })

  it("rejects bytes that are not a real raster image even if labelled as one (e.g. HTML)", () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64")
    expect(parseImageDataUri(`data:image/png;base64,${html}`)).toBeNull()
    expect(parseImageDataUri(`data:image/jpeg;base64,${Buffer.from("hello world").toString("base64")}`)).toBeNull()
  })

  it("serves iPhone HEIC logos as image/heic (Safari shows them, as it did when embedded), even when mislabelled", () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypheic"), Buffer.from([0, 0, 0, 0, 0x6d, 0x69])]).toString("base64")
    expect(parseImageDataUri(`data:image/heic;base64,${heic}`)?.contentType).toBe("image/heic")
    expect(parseImageDataUri(`data:image/webp;base64,${heic}`)?.contentType).toBe("image/heic")
  })

  it("rejects svg (can carry scripts), non-image types, non-base64 and empty payloads", () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64")
    expect(parseImageDataUri(`data:image/svg+xml;base64,${svg}`)).toBeNull()
    expect(parseImageDataUri(`data:text/html;base64,${PNG_B64}`)).toBeNull()
    expect(parseImageDataUri("data:image/png,rawtext")).toBeNull()
    expect(parseImageDataUri("data:image/png;base64,")).toBeNull()
    expect(parseImageDataUri("https://example.com/logo.png")).toBeNull()
    expect(parseImageDataUri("")).toBeNull()
  })
})

describe("shopLogoPublicUrl", () => {
  const big = (tail: string, n = 1_000_000) => `data:image/png;base64,${"A".repeat(n)}${tail}`

  it("returns null for a missing or blank logo", () => {
    expect(shopLogoPublicUrl("shop", null)).toBeNull()
    expect(shopLogoPublicUrl("shop", undefined)).toBeNull()
    expect(shopLogoPublicUrl("shop", "   ")).toBeNull()
  })

  it("leaves a normal https URL untouched", () => {
    expect(shopLogoPublicUrl("shop", "https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png")
  })

  it("swaps an embedded data URI for a short absolute route URL", () => {
    const url = shopLogoPublicUrl("my-shop", big("AAAA"))!
    expect(url.startsWith("https://www.datagod.store/api/shop-logo/my-shop?v=")).toBe(true)
    expect(url.length).toBeLessThan(120)
  })

  it("encodes the slug", () => {
    expect(shopLogoPublicUrl("a b/c", big("AAAA"))).toContain("/api/shop-logo/a%20b%2Fc?v=")
  })

  it("changes the version when the logo changes (cache busting)", () => {
    const a = shopLogoPublicUrl("s", big("AAAA"))
    expect(shopLogoPublicUrl("s", big("AAAA"))).toBe(a)
    expect(shopLogoPublicUrl("s", big("BBBB"))).not.toBe(a)
    expect(shopLogoPublicUrl("s", big("AAAA", 999_999))).not.toBe(a)
    expect(shopLogoPublicUrl("s", `${big("AAAA").slice(0, 40)}Z${big("AAAA").slice(41)}`)).not.toBe(a)
  })
})
