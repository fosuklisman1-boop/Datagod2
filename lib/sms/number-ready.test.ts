import { describe, it, expect } from "vitest"
import { buildNumberReadySms } from "./number-ready"
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
  it("a 40-char shop name with a long subdomain degrades to one segment", () => {
    const msg = buildNumberReadySms({ ...base, shopName: "A".repeat(40), subdomain: "x".repeat(60) })
    expect(calculateSegments(msg).segments).toBe(1)
    expect(msg).toContain("A".repeat(40))
    expect(msg).not.toContain("https://")
  })
  it("degrades to the bare host before dropping the link", () => {
    for (let n = 30; n < 70; n++) {
      const msg = buildNumberReadySms({ ...base, shopName: "A".repeat(40), subdomain: "x".repeat(n) })
      expect(calculateSegments(msg).segments).toBe(1)
    }
  })
  it("a non-GSM shop name still ends up one segment", () => {
    const msg = buildNumberReadySms({ ...base, shopName: "😀".repeat(30), subdomain: "kofi" })
    expect(calculateSegments(msg).segments).toBe(1)
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
