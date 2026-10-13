import { describe, it, expect } from "vitest"
import { resolveSendProvider } from "./provider-pick"

describe("resolveSendProvider", () => {
  const t = { isAdmin: false, tenantChoiceEnabled: true }
  it("admin gets a valid requested provider regardless of the tenant flag", () => {
    expect(resolveSendProvider({ requested: "hubtel", isAdmin: true, tenantChoiceEnabled: false })).toBe("hubtel")
    expect(resolveSendProvider({ requested: "moolre", isAdmin: true, tenantChoiceEnabled: false })).toBe("moolre")
  })
  it("non-admin gets it only when tenant choice is enabled", () => {
    expect(resolveSendProvider({ requested: "hubtel", ...t })).toBe("hubtel")
    expect(resolveSendProvider({ requested: "moolre", isAdmin: false, tenantChoiceEnabled: false })).toBeUndefined()
  })
  it("global / empty / garbage / non-strings are undefined for everyone", () => {
    for (const requested of ["global", "", "twilio", undefined, null, 5, {}, "HUBTEL"]) {
      expect(resolveSendProvider({ requested, isAdmin: true, tenantChoiceEnabled: true })).toBeUndefined()
      expect(resolveSendProvider({ requested, ...t })).toBeUndefined()
    }
  })
})
