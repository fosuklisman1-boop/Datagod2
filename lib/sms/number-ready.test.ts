import { describe, it, expect } from "vitest"
import { buildNumberReadySms, sanitizeShopName } from "./number-ready"
import { calculateSegments } from "./segments"

const base = { phone: "0241234567", networkLabel: "Yellow", rootDomain: "datagod.store" }

describe("buildNumberReadySms", () => {
  it("shop + subdomain: includes the tappable link and is one segment", () => {
    const msg = buildNumberReadySms({ ...base, shopName: "Kofi Data", subdomain: "kofi" })
    expect(msg).toContain("Buy again: https://kofi.datagod.store")
    expect(msg).toContain("Kofi Data")
    expect(msg).toContain("0241234567")
    expect(calculateSegments(msg).segments).toBe(1)
  })
  it("a long shop name is capped at 30 characters and a long subdomain drops the link", () => {
    const msg = buildNumberReadySms({ ...base, shopName: "A".repeat(40), subdomain: "x".repeat(60) })
    expect(calculateSegments(msg).segments).toBe(1)
    expect(msg).toContain("A".repeat(30))
    expect(msg).not.toContain("A".repeat(31))
    expect(msg).not.toContain("https://")
    expect(msg).not.toContain("x".repeat(60))
  })
  it("degrades to the bare host (no https) when only that fits", () => {
    const sub = "x".repeat(50)
    const msg = buildNumberReadySms({ ...base, shopName: "A".repeat(40), subdomain: sub })
    expect(msg).toContain(`Buy again: ${sub}.datagod.store`)
    expect(msg).not.toContain("https://")
    expect(calculateSegments(msg).segments).toBe(1)
  })
  it("every subdomain length gives one segment", () => {
    for (let n = 1; n <= 63; n++) {
      const msg = buildNumberReadySms({ ...base, shopName: "A".repeat(40), subdomain: "x".repeat(n) })
      expect(calculateSegments(msg).segments).toBe(1)
    }
  })
  it("an emoji-only shop name falls back to the generic copy", () => {
    const msg = buildNumberReadySms({ ...base, shopName: "😀".repeat(30), subdomain: "kofi", mainUssdCode: "*713*235#" })
    expect(msg).toBe("DTGOD: 0241234567 is now ready for Yellow data. Dial *713*235# or visit datagod.store")
  })
  it("a mixed name keeps its GSM part, is pure GSM and one segment", () => {
    const msg = buildNumberReadySms({ ...base, shopName: "Kofi 😀 Data 🔥 中文 Hub", subdomain: "kofi" })
    expect(msg).toContain("on Kofi Data Hub.")
    expect(calculateSegments(msg).segments).toBe(1)
    expect(/^[ -~]*$/.test(msg)).toBe(true)
  })
  it("sanitizeShopName drops newlines and collapses whitespace", () => {
    expect(sanitizeShopName("  Kofi \n\t  Data  ")).toBe("Kofi Data")
  })
  it("no shop: contains the main USSD code", () => {
    const msg = buildNumberReadySms({ ...base, mainUssdCode: "*713*235#" })
    expect(msg).toContain("*713*235#")
    expect(msg).toContain("datagod.store")
  })
  it("no shop and no code: contains datagod.store", () => {
    expect(buildNumberReadySms(base)).toContain("datagod.store")
  })
  it("never contains MTN", () => {
    expect(buildNumberReadySms({ ...base, shopName: "Kofi", subdomain: "kofi" })).not.toMatch(/MTN/i)
    expect(buildNumberReadySms({ ...base, mainUssdCode: "*713*235#" })).not.toMatch(/MTN/i)
  })
  it("subdomain with a dot gives no link", () => {
    const msg = buildNumberReadySms({ ...base, shopName: "Kofi", subdomain: "a.b" })
    expect(msg).not.toContain("Buy again")
    expect(msg).not.toContain("a.b")
  })
})
