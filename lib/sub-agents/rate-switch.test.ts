import { describe, it, expect } from "vitest"
import { canSetDealerRates } from "./rate-switch"

const mine = { parent_shop_id: "owner-shop", joined_via: "storefront" }

describe("canSetDealerRates", () => {
  it("is true for a dealer owner's own storefront joiner", () => {
    expect(canSetDealerRates("dealer", mine, "owner-shop")).toBe(true)
  })
  it("is true for an admin owner's own storefront joiner", () => {
    expect(canSetDealerRates("admin", mine, "owner-shop")).toBe(true)
  })
  it("is false for a plain user owner", () => {
    expect(canSetDealerRates("user", mine, "owner-shop")).toBe(false)
  })
  it("is false for unknown or empty roles", () => {
    expect(canSetDealerRates("", mine, "owner-shop")).toBe(false)
    expect(canSetDealerRates("Dealer", mine, "owner-shop")).toBe(false)
  })
  it("is false for another owner's sub-agent", () => {
    expect(canSetDealerRates("dealer", { ...mine, parent_shop_id: "other-shop" }, "owner-shop")).toBe(false)
  })
  it("is false for a sub-agent with no parent", () => {
    expect(canSetDealerRates("dealer", { ...mine, parent_shop_id: null }, "owner-shop")).toBe(false)
  })
  it("is false for an invited sub-agent", () => {
    expect(canSetDealerRates("dealer", { parent_shop_id: "owner-shop", joined_via: null }, "owner-shop")).toBe(false)
  })
  it("is false for an unrecognised joined_via", () => {
    expect(canSetDealerRates("dealer", { parent_shop_id: "owner-shop", joined_via: "invite" }, "owner-shop")).toBe(false)
  })
  it("is false when the owner shop id is empty", () => {
    expect(canSetDealerRates("dealer", { parent_shop_id: "", joined_via: "storefront" }, "")).toBe(false)
  })
})
