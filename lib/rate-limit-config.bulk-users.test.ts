import { describe, it, expect } from "vitest"
import { isHeavyAdminOperation } from "./rate-limit-config"

describe("heavy admin operations", () => {
  it("include the users bulk action (up to 200 account changes or 5000 notifications per call)", () => {
    expect(isHeavyAdminOperation("/api/admin/users/bulk")).toBe(true)
    expect(isHeavyAdminOperation("/api/admin/users")).toBe(false)
  })
})
