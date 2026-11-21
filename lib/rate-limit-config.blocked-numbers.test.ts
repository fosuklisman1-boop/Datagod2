import { describe, it, expect } from "vitest"
import { isHeavyAdminOperation } from "./rate-limit-config"
import { isRegisteredNavHref } from "./nav-new"

describe("blocked numbers admin wiring", () => {
  it("export and recheck are heavy admin operations", () => {
    expect(isHeavyAdminOperation("/api/admin/blocked-numbers/export")).toBe(true)
    expect(isHeavyAdminOperation("/api/admin/blocked-numbers/recheck")).toBe(true)
    expect(isHeavyAdminOperation("/api/admin/blocked-numbers/check-all")).toBe(true)
    expect(isHeavyAdminOperation("/api/admin/blocked-numbers")).toBe(false)
  })

  it("the admin page has a NEW tag entry", () => {
    expect(isRegisteredNavHref("/admin/blocked-numbers")).toBe(true)
  })
})
