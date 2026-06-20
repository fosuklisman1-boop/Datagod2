import {
  parseGbFromVolume,
  findProductIdInCatalog,
  normalizeStatus,
  type BisdelProduct,
} from "@/lib/mtn-providers/bisdel-provider"

describe("parseGbFromVolume", () => {
  it("parses GB strings", () => expect(parseGbFromVolume("1GB")).toBe(1))
  it("parses decimal GB with a space", () => expect(parseGbFromVolume("1.5 GB")).toBe(1.5))
  it("converts MB to GB", () => expect(parseGbFromVolume("500MB")).toBeCloseTo(0.488, 2))
  it("accepts a bare numeric string", () => expect(parseGbFromVolume("2")).toBe(2))
  it("accepts a number", () => expect(parseGbFromVolume(3)).toBe(3))
  it("returns null for junk", () => expect(parseGbFromVolume("free")).toBeNull())
  it("returns null for null", () => expect(parseGbFromVolume(null)).toBeNull())
})

describe("normalizeStatus", () => {
  it("maps success synonyms to completed", () => expect(normalizeStatus("Delivered")).toBe("completed"))
  it("maps failure synonyms to failed", () => expect(normalizeStatus("Cancelled")).toBe("failed"))
  it("maps in-progress synonyms to processing", () => expect(normalizeStatus("in progress")).toBe("processing"))
  it("keeps explicit pending values pending", () => {
    expect(normalizeStatus("pending")).toBe("pending")
    expect(normalizeStatus("Waiting")).toBe("pending")
    expect(normalizeStatus("new")).toBe("pending")
  })
  // Mirrors Sykes: unknown / blank statuses fall through to processing, NOT pending,
  // so a placed Bisdel order advances past pending the way Sykes orders do.
  it("defaults unknown to processing (matches Sykes)", () => expect(normalizeStatus("whatever")).toBe("processing"))
  it("treats empty as processing", () => expect(normalizeStatus("")).toBe("processing"))
})

describe("findProductIdInCatalog", () => {
  const catalog: BisdelProduct[] = [
    { product_id: 1, data_volume: "1GB", network: "MTN", category: "Daily Bundles" },
    { product_id: 2, data_volume: "1GB", network: "MTN", category: "Monthly Bundles" },
    { product_id: 3, data_volume: "2GB", network: "MTN", category: "Monthly Bundles" },
    { product_id: 9, data_volume: "1GB", network: "AT", category: "Monthly Bundles" },
  ]
  it("matches by GB within the chosen category", () =>
    expect(findProductIdInCatalog(catalog, "Monthly Bundles", 2)).toBe(3))
  it("resolves same-GB collisions via category", () => {
    expect(findProductIdInCatalog(catalog, "Monthly Bundles", 1)).toBe(2)
    expect(findProductIdInCatalog(catalog, "Daily Bundles", 1)).toBe(1)
  })
  it("ignores non-MTN products even inside the category", () =>
    expect(findProductIdInCatalog(catalog, "Monthly Bundles", 1)).toBe(2))
  it("returns null when no category is chosen", () => {
    expect(findProductIdInCatalog(catalog, null, 1)).toBeNull()
    expect(findProductIdInCatalog(catalog, "", 1)).toBeNull()
  })
  it("returns null when no GB match in the category", () =>
    expect(findProductIdInCatalog(catalog, "Daily Bundles", 2)).toBeNull())
})
