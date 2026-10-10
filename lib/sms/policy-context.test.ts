import { describe, it, expect, vi } from "vitest"
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
import { audienceFor, buildShadow, PLATFORM_ROOT_DOMAIN } from "./policy-context"

describe("audienceFor", () => {
  it("maps owner types", () => {
    expect(audienceFor("platform", "admin")).toBe("admin")
    expect(audienceFor("shop", "dealer")).toBe("shop_owner")
    expect(audienceFor("sub_agent", "sub_agent")).toBe("sub_agent")
    expect(audienceFor("individual", "dealer")).toBe("dealer")
    expect(audienceFor("individual", null)).toBe("user")
  })
})

describe("buildShadow", () => {
  it("records the decision, record-only", () => {
    const s = buildShadow({ decision: "block", code: "LINK_NOT_ALLOWED", reason: "r", flags: [] }, false, new Date("2026-10-10T00:00:00Z"))
    expect(s).toEqual({ decision: "block", code: "LINK_NOT_ALLOWED", reason: "r", flags: [], enforced: false, evaluated_at: "2026-10-10T00:00:00.000Z" })
  })
})

it("root domain is datagod.store", () => expect(PLATFORM_ROOT_DOMAIN).toBe("datagod.store"))
