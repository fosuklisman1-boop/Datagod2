// lib/ussd/price-role.test.ts
import { describe, it, expect } from "vitest"
import { tierToSlug, buyerPriceRole, sessionPriceRole } from "./price-role"

describe("tierToSlug", () => {
  it.each([
    ["dealer", "dealer"],
    ["regular", "user"],
    ["sub_agent", "user"],
    [undefined, "user"],
    [null, "user"],
    ["gold", "user"],
  ])("%s -> %s", (tier, slug) => {
    expect(tierToSlug(tier as string | undefined)).toBe(slug)
  })
})

describe("buyerPriceRole", () => {
  it.each([
    ["dealer", undefined, "dealer"],
    ["admin", undefined, "user"],
    ["user", undefined, "user"],
    ["sub_agent", undefined, "sub_agent"],
    ["gold", undefined, "gold"],
    [undefined, "dealer", "dealer"],
    [undefined, "regular", "user"],
    [undefined, undefined, "user"],
  ])("role %s default %s -> %s", (role, def, slug) => {
    expect(buyerPriceRole(role as string | undefined, def as string | undefined)).toBe(slug)
  })
})

describe("sessionPriceRole", () => {
  it("prefers priceRole", () => expect(sessionPriceRole({ priceRole: "gold" })).toBe("gold"))
  it("falls back to the tier", () => expect(sessionPriceRole({ effectivePriceTier: "dealer" })).toBe("dealer"))
  it("empty session is user", () => expect(sessionPriceRole({})).toBe("user"))
})
