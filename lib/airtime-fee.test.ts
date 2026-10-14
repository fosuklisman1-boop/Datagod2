import { describe, it, expect } from "vitest"
import { airtimeAmountGate, airtimeEnabledKey, airtimeFeeKey, airtimeNetworkGate, airtimeSettingsSuffix, legacyAirtimePrice } from "./airtime-fee"

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

describe("airtime gates", () => {
  const reader = (s: Record<string, any>) => async (k: string) => s[k] ?? null

  it("network gate blocks only an explicit enabled:false, by the at key for both AT spellings", async () => {
    const off = reader({ airtime_enabled_at: { enabled: false } })
    expect(await airtimeNetworkGate("AT", off)).toStrictEqual({
      code: "NETWORK_DISABLED", status: 403, message: "Airtime for AT is currently unavailable",
    })
    expect((await airtimeNetworkGate("AirtelTigo", off))?.code).toBe("NETWORK_DISABLED")
    expect(await airtimeNetworkGate("MTN", off)).toBeNull()
    expect(await airtimeNetworkGate("AT", reader({ airtime_enabled_at: { enabled: true } }))).toBeNull()
  })

  it("amount gate uses admin min/max with 1/500 defaults, inclusive", async () => {
    const r = reader({ airtime_min_amount: { amount: 2 }, airtime_max_amount: { amount: 50 } })
    expect(await airtimeAmountGate(2, r)).toBeNull()
    expect(await airtimeAmountGate(50, r)).toBeNull()
    expect(await airtimeAmountGate(1.99, r)).toStrictEqual({ code: "INVALID_AMOUNT", status: 400, message: "Minimum airtime amount is GHS 2" })
    expect(await airtimeAmountGate(50.01, r)).toStrictEqual({ code: "INVALID_AMOUNT", status: 400, message: "Maximum airtime amount is GHS 50" })
    expect(await airtimeAmountGate(0.99, reader({}))).toMatchObject({ message: "Minimum airtime amount is GHS 1" })
    expect(await airtimeAmountGate(501, reader({}))).toMatchObject({ message: "Maximum airtime amount is GHS 500" })
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
