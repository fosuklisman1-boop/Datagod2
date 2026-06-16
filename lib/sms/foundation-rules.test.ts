import { describe, it, expect } from "vitest"
import { deriveOwnerType, canPurchaseBundle } from "./foundation-rules"

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
    expect(deriveOwnerType({ role: "admin", ownsShop: true, isSubAgent: false, shopId: "s1" }).ownerType)
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
