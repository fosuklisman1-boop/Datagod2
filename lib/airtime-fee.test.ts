import { describe, it, expect } from "vitest"
import { airtimeEnabledKey, airtimeFeeKey, airtimeSettingsSuffix, legacyAirtimePrice } from "./airtime-fee"

describe("airtime settings keys", () => {
  it("MTN and Telecel keep their historical suffixes", () => {
    expect(airtimeSettingsSuffix("MTN")).toBe("mtn")
    expect(airtimeSettingsSuffix("Telecel")).toBe("telecel")
    expect(airtimeFeeKey("MTN", "customer")).toBe("airtime_fee_mtn_customer")
    expect(airtimeFeeKey("Telecel", "dealer")).toBe("airtime_fee_telecel_dealer")
    expect(airtimeEnabledKey("MTN")).toBe("airtime_enabled_mtn")
    expect(airtimeEnabledKey("Telecel")).toBe("airtime_enabled_telecel")
  })
  it("AT and AirtelTigo both read the at keys", () => {
    for (const n of ["AT", "AirtelTigo"]) {
      expect(airtimeEnabledKey(n)).toBe("airtime_enabled_at")
      expect(airtimeFeeKey(n, "customer")).toBe("airtime_fee_at_customer")
      expect(airtimeFeeKey(n, "dealer")).toBe("airtime_fee_at_dealer")
    }
  })
  it("unknown names keep the old lowercase form", () => {
    expect(airtimeSettingsSuffix("Glo Mobile")).toBe("glo_mobile")
  })
})

describe("legacyAirtimePrice", () => {
  it("pay separately adds the fee", () => {
    expect(legacyAirtimePrice(10, 5, true)).toEqual({ toRecipient: 10, fee: 0.5, total: 10.5 })
  })
  it("fee deducted from the amount", () => {
    expect(legacyAirtimePrice(10, 5, false)).toEqual({ toRecipient: 9.52, fee: 0.48, total: 10 })
  })
})
