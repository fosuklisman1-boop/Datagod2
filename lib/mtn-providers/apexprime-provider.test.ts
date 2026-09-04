import { mapNetworkToApex, normalizeApexStatus, findMatchingProduct, parseTrackingId } from "@/lib/mtn-providers/apexprime-provider"

describe("mapNetworkToApex", () => {
  it("maps MTN to MTN", () => expect(mapNetworkToApex("MTN")).toBe("MTN"))
  it("maps Telecel to Telecel", () => expect(mapNetworkToApex("Telecel")).toBe("Telecel"))
  it("maps AirtelTigo to Ishare", () => expect(mapNetworkToApex("AirtelTigo")).toBe("Ishare"))
})

describe("normalizeApexStatus", () => {
  it("maps completed variants to completed", () => {
    expect(normalizeApexStatus("completed")).toBe("completed")
    expect(normalizeApexStatus("Success")).toBe("completed")
    expect(normalizeApexStatus("SUCCESSFUL")).toBe("completed")
  })
  it("maps failure variants to failed", () => {
    expect(normalizeApexStatus("failed")).toBe("failed")
    expect(normalizeApexStatus("Rejected")).toBe("failed")
    expect(normalizeApexStatus("cancelled")).toBe("failed")
    expect(normalizeApexStatus("refunded")).toBe("failed")
  })
  it("maps pending variants to pending", () => {
    expect(normalizeApexStatus("pending")).toBe("pending")
    expect(normalizeApexStatus("Waiting")).toBe("pending")
  })
  it("defaults unknown/blank to processing", () => {
    expect(normalizeApexStatus("something-else")).toBe("processing")
    expect(normalizeApexStatus("")).toBe("processing")
  })
})

describe("findMatchingProduct", () => {
  const products = [
    { product_id: 14, type: "data", network: "MTN", gb_amount: 1 },
    { product_id: 15, type: "data", network: "MTN", gb_amount: 5 },
    { product_id: 16, type: "data", network: "Telecel", gb_amount: 5 },
    { product_id: "wassce", type: "digital" },
  ]
  it("matches by exact network and GB amount", () => {
    expect(findMatchingProduct(products, "MTN", 5)).toBe(15)
  })
  it("is case-insensitive on network", () => {
    expect(findMatchingProduct(products, "mtn", 1)).toBe(14)
  })
  it("does not match a different network with the same GB amount", () => {
    expect(findMatchingProduct(products, "Ishare", 5)).toBeUndefined()
  })
  it("ignores non-data products", () => {
    expect(findMatchingProduct(products, "wassce" as any, 1)).toBeUndefined()
  })
  it("returns undefined when no GB amount matches", () => {
    expect(findMatchingProduct(products, "MTN", 100)).toBeUndefined()
  })
})

describe("parseTrackingId", () => {
  it("parses a bundle-prefixed id", () => {
    expect(parseTrackingId("bundle:10839")).toEqual({ kind: "bundle", rawId: "10839" })
  })
  it("parses a store-prefixed id", () => {
    expect(parseTrackingId("store:abc-123-uuid")).toEqual({ kind: "store", rawId: "abc-123-uuid" })
  })
  it("returns null for an unprefixed id", () => {
    expect(parseTrackingId("10839")).toBeNull()
  })
  it("returns null for an unrecognized prefix", () => {
    expect(parseTrackingId("other:10839")).toBeNull()
  })
  it("returns null for an empty raw id after the prefix", () => {
    expect(parseTrackingId("bundle:")).toBeNull()
  })
})
