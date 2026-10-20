import { describe, it, expect } from "vitest"
import { resolveCustomerEmail } from "./guest-email"

describe("resolveCustomerEmail", () => {
  it("keeps a typed email, trimmed", () => {
    expect(resolveCustomerEmail("  a@b.com ", "0241234567")).toBe("a@b.com")
  })
  it("synthesizes from the phone when blank", () => {
    expect(resolveCustomerEmail("", "024 123 4567")).toBe("guest0241234567@datagod.store")
    expect(resolveCustomerEmail("   ", "0241234567")).toBe("guest0241234567@datagod.store")
    expect(resolveCustomerEmail(undefined, "0241234567")).toBe("guest0241234567@datagod.store")
  })
  it("returns empty when there is neither email nor phone", () => {
    expect(resolveCustomerEmail("", "")).toBe("")
    expect(resolveCustomerEmail(undefined, undefined)).toBe("")
  })
})
