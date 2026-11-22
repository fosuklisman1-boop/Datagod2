import { describe, it, expect } from "vitest"
import { isEligible, canRequestKey } from "./eligibility"

describe("isEligible", () => {
  it("a grant makes a role outside the allowed list eligible", () => {
    expect(isEligible({ hasGrant: true, role: "user", allowedRoles: ["dealer"] })).toBe(true)
  })
  it("no grant and a role outside the list is not eligible", () => {
    expect(isEligible({ hasGrant: false, role: "user", allowedRoles: ["dealer"] })).toBe(false)
  })
  it("an allowed role is eligible without a grant, a custom slug included", () => {
    expect(isEligible({ hasGrant: false, role: "dealer", allowedRoles: ["dealer"] })).toBe(true)
    expect(isEligible({ hasGrant: false, role: "reseller", allowedRoles: ["reseller"] })).toBe(true)
  })
  it("an empty allowed list with no grant is not eligible", () => {
    expect(isEligible({ hasGrant: false, role: "admin", allowedRoles: [] })).toBe(false)
  })
})

describe("canRequestKey", () => {
  it("an allowed role without the capability cannot request a key", () => {
    expect(canRequestKey({ hasGrant: false, role: "dealer", allowedRoles: ["dealer"], hasApiCapability: false })).toBe(false)
  })
  it("a grant without the capability can", () => {
    expect(canRequestKey({ hasGrant: true, role: "user", allowedRoles: [], hasApiCapability: false })).toBe(true)
  })
  it("an allowed role with the capability can", () => {
    expect(canRequestKey({ hasGrant: false, role: "dealer", allowedRoles: ["dealer"], hasApiCapability: true })).toBe(true)
  })
  it("the capability alone, with a role not allowed and no grant, cannot", () => {
    expect(canRequestKey({ hasGrant: false, role: "user", allowedRoles: ["dealer"], hasApiCapability: true })).toBe(false)
  })
})
