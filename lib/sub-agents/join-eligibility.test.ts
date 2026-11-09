import { describe, it, expect } from "vitest"
import { targetStatus, joinerStatus } from "./join-eligibility"

const shop = { is_active: true, is_blocked: false, parent_shop_id: null as string | null }

describe("targetStatus", () => {
  it("is open for an active, unblocked top-level shop with the switch on", () => {
    expect(targetStatus(shop, true)).toBe("open")
  })
  it("is closed when the switch is off", () => {
    expect(targetStatus(shop, false)).toBe("closed")
  })
  it("is closed for a missing shop", () => {
    expect(targetStatus(null, true)).toBe("closed")
  })
  it("is closed for a sub-agent shop", () => {
    expect(targetStatus({ ...shop, parent_shop_id: "p1" }, true)).toBe("closed")
  })
  it("is closed for a blocked shop", () => {
    expect(targetStatus({ ...shop, is_blocked: true }, true)).toBe("closed")
  })
  it("is closed for an inactive shop", () => {
    expect(targetStatus({ ...shop, is_active: false }, true)).toBe("closed")
  })
})

describe("joinerStatus", () => {
  it("lets a plain user without a shop join", () => {
    expect(joinerStatus({ role: "user", hasShop: false })).toBe("can_join")
  })
  it("reports has_shop for a shop owner", () => {
    expect(joinerStatus({ role: "user", hasShop: true })).toBe("has_shop")
  })
  it("does not allow dealers", () => {
    expect(joinerStatus({ role: "dealer", hasShop: false })).toBe("not_allowed")
  })
  it("does not allow admins", () => {
    expect(joinerStatus({ role: "admin", hasShop: false })).toBe("not_allowed")
  })
  it("dealer or admin wins over having a shop", () => {
    expect(joinerStatus({ role: "dealer", hasShop: true })).toBe("not_allowed")
    expect(joinerStatus({ role: "admin", hasShop: true })).toBe("not_allowed")
  })
})
