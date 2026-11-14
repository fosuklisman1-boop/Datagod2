import { describe, it, expect } from "vitest"
import { roleFromMetadata } from "./metadata-role"

describe("roleFromMetadata", () => {
  it("never returns admin: users write their own metadata (signUp options.data / auth.updateUser)", () => {
    expect(roleFromMetadata({ role: "admin" })).toBeNull()
    expect(roleFromMetadata({ role: "Admin" })).toBeNull()
    expect(roleFromMetadata({ role: " ADMIN " })).toBeNull()
  })

  it("passes the non-privileged display roles through as a fallback", () => {
    expect(roleFromMetadata({ role: "dealer" })).toBe("dealer")
    expect(roleFromMetadata({ role: "sub_agent" })).toBe("sub_agent")
    expect(roleFromMetadata({ role: "user" })).toBe("user")
  })

  it("ignores missing, empty and non-string or unknown roles", () => {
    expect(roleFromMetadata(undefined)).toBeNull()
    expect(roleFromMetadata(null)).toBeNull()
    expect(roleFromMetadata({})).toBeNull()
    expect(roleFromMetadata({ role: "" })).toBeNull()
    expect(roleFromMetadata({ role: 1 })).toBeNull()
    expect(roleFromMetadata({ role: "superuser" })).toBeNull()
  })
})
