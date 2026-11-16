import { describe, it, expect } from "vitest"
import { buildShopOrderConfirmation } from "./shop-order-confirmation"
import { calculateSegments } from "./segments"

const base = {
  networkLabel: "Yellow",
  volume: "5",
  phone: "0241234567",
  ownerPhone: "0551234567",
  subdomain: "kofidata",
  rootDomain: "datagod.store",
}

describe("buildShopOrderConfirmation", () => {
  it("renders the short wording with the https shop link", () => {
    expect(buildShopOrderConfirmation(base)).toBe(
      "Order placed: Yellow 5G.B to 0241234567. Delayed over 2hrs? Call 0551234567. Buy again: https://kofidata.datagod.store"
    )
  })

  it("fits ONE segment for the worst case seen in prod (40-char subdomain, +233 owner, Blue Big, 100GB)", () => {
    const msg = buildShopOrderConfirmation({
      ...base,
      networkLabel: "Blue Big",
      volume: "100",
      ownerPhone: "+233551234567",
      subdomain: "a".repeat(40),
    })
    expect(msg).toContain(`https://${"a".repeat(40)}.datagod.store`)
    expect(calculateSegments(msg).segments).toBe(1)
  })

  it("drops https:// when the full link would overflow one segment", () => {
    const msg = buildShopOrderConfirmation({ ...base, networkLabel: "Blue Big", volume: "100", ownerPhone: "+233551234567", subdomain: "a".repeat(46) })
    expect(msg).toContain(`Buy again: ${"a".repeat(46)}.datagod.store`)
    expect(msg).not.toContain("https://")
    expect(calculateSegments(msg).segments).toBe(1)
  })

  it("drops the link entirely when even the bare link overflows", () => {
    const msg = buildShopOrderConfirmation({ ...base, subdomain: "a".repeat(63), ownerPhone: "+233551234567", networkLabel: "Blue Big", volume: "100" })
    expect(msg).toBe("Order placed: Blue Big 100G.B to 0241234567. Delayed over 2hrs? Call +233551234567.")
    expect(calculateSegments(msg).segments).toBe(1)
  })

  it("omits the link when the shop has no usable subdomain", () => {
    for (const subdomain of [null, undefined, "", "Bad Sub", "evil.com/x", "shöp"]) {
      expect(buildShopOrderConfirmation({ ...base, subdomain })).toBe(
        "Order placed: Yellow 5G.B to 0241234567. Delayed over 2hrs? Call 0551234567."
      )
    }
  })

  it("lowercases the subdomain", () => {
    expect(buildShopOrderConfirmation({ ...base, subdomain: "KofiData" })).toContain("https://kofidata.datagod.store")
  })

  it("reads naturally with the 'support' owner fallback", () => {
    expect(buildShopOrderConfirmation({ ...base, ownerPhone: "support" })).toContain("Delayed over 2hrs? Call support.")
  })
})
