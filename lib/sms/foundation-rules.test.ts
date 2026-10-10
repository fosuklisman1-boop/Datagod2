import { describe, it, expect } from "vitest"
import { deriveOwnerType, canPurchaseBundle, bundleVisibleTo } from "./foundation-rules"

describe("individual accounts via Allowed Roles", () => {
  it("dealer without a shop gets an individual account when dealers are allowed", () => {
    expect(deriveOwnerType({ role: "dealer", ownsShop: false, isSubAgent: false, allowedRoles: ["dealer"] }))
      .toEqual({ ownerType: "individual", ownerId: null })
  })
  it("not allowed → no account (today's behaviour)", () => {
    expect(deriveOwnerType({ role: "user", ownsShop: false, isSubAgent: false, allowedRoles: ["shop_owner"] })).toBeNull()
  })
  it("default allowed roles still give plain users/dealers nothing", () => {
    expect(deriveOwnerType({ role: "dealer", ownsShop: false, isSubAgent: false, allowedRoles: ["shop_owner", "sub_agent"] })).toBeNull()
  })
  it("shop owners keep shop accounts regardless", () => {
    expect(deriveOwnerType({ role: "user", ownsShop: true, isSubAgent: false, shopId: "s1", allowedRoles: [] })?.ownerType).toBe("shop")
  })
})

describe("bundleVisibleTo", () => {
  const b = { id: "1", active: true, owner_type_scope: "all" as const, mode: "platform" as const }
  it("matches mode", () => {
    expect(bundleVisibleTo(b, "shop", "platform")).toBe(true)
    expect(bundleVisibleTo(b, "shop", "business")).toBe(false)
  })
  it("respects active + scope", () => {
    expect(bundleVisibleTo({ ...b, active: false }, "shop", "platform")).toBe(false)
    expect(bundleVisibleTo({ ...b, owner_type_scope: "sub_agent" }, "shop", "platform")).toBe(false)
  })
})

describe("deriveOwnerType", () => {
  it("admin → platform", () => {
    expect(deriveOwnerType({ role: "admin", ownsShop: false, isSubAgent: false }))
      .toEqual({ ownerType: "platform", ownerId: null })
  })
  it("shop owner → shop with shopId", () => {
    expect(deriveOwnerType({ role: "dealer", ownsShop: true, isSubAgent: false, shopId: "s1" }))
      .toEqual({ ownerType: "shop", ownerId: "s1" })
  })
  it("sub-agent → sub_agent with subAgentId", () => {
    expect(deriveOwnerType({ role: "user", ownsShop: false, isSubAgent: true, subAgentId: "a1" }))
      .toEqual({ ownerType: "sub_agent", ownerId: "a1" })
  })
  it("admin who also owns a shop still resolves to platform", () => {
    expect(deriveOwnerType({ role: "admin", ownsShop: true, isSubAgent: false, shopId: "s1" })?.ownerType)
      .toBe("platform")
  })
  it("plain user with no shop/sub-agent → null (no SMS account)", () => {
    expect(deriveOwnerType({ role: "user", ownsShop: false, isSubAgent: false })).toBeNull()
  })
})

describe("canPurchaseBundle", () => {
  const base = { id: "b1", active: true, owner_type_scope: "all" as const }
  it("active 'all' bundle is purchasable by any owner", () => {
    expect(canPurchaseBundle(base, "shop").ok).toBe(true)
  })
  it("inactive bundle is rejected", () => {
    expect(canPurchaseBundle({ ...base, active: false }, "shop"))
      .toEqual({ ok: false, reason: "Bundle is not available" })
  })
  it("scoped bundle rejects a mismatched owner type", () => {
    expect(canPurchaseBundle({ ...base, owner_type_scope: "sub_agent" }, "shop"))
      .toEqual({ ok: false, reason: "Bundle not available for this account type" })
  })
  it("scoped bundle accepts the matching owner type", () => {
    expect(canPurchaseBundle({ ...base, owner_type_scope: "shop" }, "shop").ok).toBe(true)
  })
})
