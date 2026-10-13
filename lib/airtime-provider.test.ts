import { describe, expect, it } from "vitest"
import { AIRTIME_PROVIDER_KEYS, airtimeNetId, airtimeProviderKey, getAirtimeProvider, parseAirtimeProvider } from "./airtime-provider"

const dbWith = (value: unknown, error: unknown = null) => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: value === undefined ? null : { value }, error }) }) }) }),
}) as any

describe("airtime provider setting", () => {
  it("maps airtime_orders network values", () => {
    expect(airtimeNetId("MTN")).toBe("mtn")
    expect(airtimeNetId("Telecel")).toBe("telecel")
    expect(airtimeNetId("AT")).toBe("at")
    expect(airtimeNetId("AirtelTigo")).toBe("at")
    expect(airtimeNetId("Glo")).toBeNull()
  })
  it("keys", () => {
    expect(airtimeProviderKey("mtn")).toBe("airtime_provider_mtn")
    expect(AIRTIME_PROVIDER_KEYS).toEqual(["airtime_provider_mtn", "airtime_provider_telecel", "airtime_provider_at"])
  })
  it("parses only the three providers", () => {
    expect(parseAirtimeProvider({ provider: "hubtel" })).toBe("hubtel")
    expect(parseAirtimeProvider({ provider: "HUBTEL" })).toBeNull()
    expect(parseAirtimeProvider("hubtel")).toBeNull()
    expect(parseAirtimeProvider(null)).toBeNull()
  })
  it("explicit setting wins over the legacy toggle", async () => {
    expect(await getAirtimeProvider(dbWith({ provider: "hubtel" }), "MTN", async () => true)).toBe("hubtel")
    expect(await getAirtimeProvider(dbWith({ provider: "manual" }), "MTN", async () => true)).toBe("manual")
  })
  it("falls back to legacy when absent, invalid, or unreadable", async () => {
    expect(await getAirtimeProvider(dbWith(undefined), "MTN", async () => true)).toBe("digiwapy")
    expect(await getAirtimeProvider(dbWith(undefined), "MTN", async () => false)).toBe("manual")
    expect(await getAirtimeProvider(dbWith({ provider: "x" }), "MTN", async () => true)).toBe("digiwapy")
    expect(await getAirtimeProvider(dbWith(null, { message: "db down" }), "MTN", async () => true)).toBe("digiwapy")
  })
  it("unknown network is manual", async () => {
    expect(await getAirtimeProvider(dbWith({ provider: "hubtel" }), "Glo", async () => true)).toBe("manual")
  })
})
