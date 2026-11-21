import { describe, it, expect } from "vitest"
import { splitCopyChips } from "./copy-chips"

const chips = (t: string) => splitCopyChips(t).filter((p) => p.kind === "chip")
const join = (t: string) => splitCopyChips(t).map((p) => p.value).join("")

describe("copy chips", () => {
  it("copy_chips_detects_order_code_ussd_phone", () => {
    const t = "Order ORD-1732100000000 and AFA-1234567 and AT-A2B-C3D, dial *713*235# or call 0241234567, 233241234567, +233241234567."
    expect(chips(t).map((c) => [c.value, c.chipType])).toEqual([
      ["ORD-1732100000000", "code"],
      ["AFA-1234567", "code"],
      ["AT-A2B-C3D", "code"],
      ["*713*235#", "ussd"],
      ["0241234567", "phone"],
      ["233241234567", "phone"],
      ["+233241234567", "phone"],
    ])
    expect(chips("ORD-1732100000000-K7M2P9XQA done")[0].value).toBe("ORD-1732100000000-K7M2P9XQA")
    expect(chips("SBR-0a1b2c3d4e5f")[0].value).toBe("SBR-0a1b2c3d4e5f")
  })
  it("copy_chips_ignores_inside_words", () => {
    expect(chips("abc0241234567 0241234567x 02412345678 xORD-123 ORD-123abc_ 12233241234567")).toEqual([])
    expect(chips("price *5# ok")).toEqual([{ kind: "chip", value: "*5#", chipType: "ussd" }])
  })
  it("copy_chips_preserves_text", () => {
    for (const t of ["", "plain", "a ORD-1, *713# 0241234567.\n**bold** 0241234567", "x*#y *713*1#z", "ORD- ORD-", "(0241234567)"]) {
      expect(join(t)).toBe(t)
    }
  })
})

describe("copy chips names", () => {
  it("copy_chips_ignores_product_names", () => {
    expect(chips("AT-iShare AT-BigTime AT-Premium MTN-data RC-results AT-Ishare, RCK-vouchers")).toEqual([])
    expect(chips("AT-A2B-C3D")).toHaveLength(1)
    expect(chips("ORD-1732100000000")).toHaveLength(1)
    expect(chips("AFA-1234567")).toHaveLength(1)
    expect(chips("SBR-0a1b2c3d4e5f")).toHaveLength(1)
  })
})
