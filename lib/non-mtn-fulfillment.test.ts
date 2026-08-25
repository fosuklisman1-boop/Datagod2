import { normalizeNetworkKey } from "./non-mtn-fulfillment"

describe("normalizeNetworkKey", () => {
  it("normalizes AT-iShare variants (spaced, unspaced, lowercase)", () => {
    expect(normalizeNetworkKey("AT - iShare")).toBe("AT - ISHARE")
    expect(normalizeNetworkKey("AT-iShare")).toBe("AT - ISHARE")
    expect(normalizeNetworkKey("at - ishare")).toBe("AT - ISHARE")
    expect(normalizeNetworkKey("AT-ISHARE")).toBe("AT - ISHARE")
  })

  it("normalizes AT-BigTime variants (spaced, unspaced, lowercase)", () => {
    expect(normalizeNetworkKey("AT - BigTime")).toBe("AT - BIGTIME")
    expect(normalizeNetworkKey("AT-BigTime")).toBe("AT - BIGTIME")
    expect(normalizeNetworkKey("at - bigtime")).toBe("AT - BIGTIME")
    expect(normalizeNetworkKey("AT-BIGTIME")).toBe("AT - BIGTIME")
  })

  it("normalizes Telecel variants", () => {
    expect(normalizeNetworkKey("Telecel")).toBe("TELECEL")
    expect(normalizeNetworkKey("telecel")).toBe("TELECEL")
    expect(normalizeNetworkKey("TELECEL")).toBe("TELECEL")
  })

  it("falls back to AIRTELTIGO for a generic AirtelTigo label", () => {
    expect(normalizeNetworkKey("AirtelTigo")).toBe("AIRTELTIGO")
    expect(normalizeNetworkKey("AIRTELTIGO")).toBe("AIRTELTIGO")
  })
})
