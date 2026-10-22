import { describe, it, expect } from "vitest"
import { mapRole, mapBalance } from "./account"

describe("account mappers", () => {
  it("mapRole", () => {
    expect(
      mapRole({
        keyId: "k",
        userId: "u",
        role: "dealer",
        keyType: "standard",
        environment: "live",
        firstName: null,
      })
    ).toEqual({ role: "dealer", key_type: "standard", environment: "live" })
  })

  it("mapBalance rounds to 2dp", () => {
    expect(mapBalance({ balance: 12.345, total_credited: 20, total_spent: 7.655 })).toEqual({
      balance: 12.35,
      total_credited: 20,
      total_spent: 7.66,
      currency: "GHS",
    })
  })

  it("mapBalance null", () => {
    expect(mapBalance(null)).toBeNull()
  })
})
