import { describe, it, expect } from "vitest"
import {
  buildPriceTables, cheapestRows, formatSize, networkOf, rowLabel, sizeInMb, tableColumns, typeOf, validityOf,
  type RawPackageRow,
} from "./data-prices"
import { buildLiveFacts, FAILED_RAW } from "./live-facts"

const row = (network: string, size: string, price: number | string | null, over: Partial<RawPackageRow> = {}): RawPackageRow => ({
  network, size, price, is_available: true, description: null, ...over,
})

describe("formatSize / sizeInMb", () => {
  it("normalises plain and unit sizes", () => {
    expect(formatSize("1")).toBe("1GB")
    expect(formatSize("1GB")).toBe("1GB")
    expect(formatSize(" 2 gb ")).toBe("2GB")
    expect(formatSize("1.5GB")).toBe("1.5GB")
    expect(formatSize("500MB")).toBe("500MB")
    expect(formatSize("Unlimited night")).toBe("Unlimited night")
    expect(formatSize(null)).toBe("")
  })
  it("orders MB below GB and unknown sizes last", () => {
    expect(sizeInMb("500MB")).toBeLessThan(sizeInMb("1GB"))
    expect(sizeInMb("1GB")).toBe(1024)
    expect(sizeInMb("Unlimited")).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("typeOf / validityOf", () => {
  it("names AT sub-products only for AT rows", () => {
    expect(typeOf("AT - iShare")).toBe("iShare")
    expect(typeOf("AT-ISHARE")).toBe("iShare")
    expect(typeOf("AT - BigTime")).toBe("BigTime")
    expect(typeOf("AirtelTigo")).toBeNull()
    expect(typeOf("MTN")).toBeNull()
    expect(typeOf("Telecel")).toBeNull()
  })
  it("reads a validity only when the description states one", () => {
    expect(validityOf("No Expiry")).toBe("No expiry")
    expect(validityOf("non-expiry bundle")).toBe("No expiry")
    expect(validityOf("Valid for 30 days")).toBe("30 days")
    expect(validityOf("1 day")).toBe("1 day")
    expect(validityOf("24 hrs")).toBe("24 hours")
    expect(validityOf("Fast data")).toBeNull()
    expect(validityOf(null)).toBeNull()
    expect(validityOf("")).toBeNull()
  })
})

describe("buildPriceTables", () => {
  const tables = buildPriceTables([
    row("MTN", "5", 22),
    row("MTN", "1", 5.5),
    row("MTN", "2", "10.00"),
    row("MTN", "500MB", 3),
    row("MTN", "3", 12, { is_available: false }),
    row("MTN", "4", 0),
    row("MTN", "6", null),
    row("MTN", "", 9),
    row("MTN", "1", 5.5), // exact duplicate
    row("Telecel", "10", 40, { description: "No Expiry" }),
    row("Telecel", "1", 6, { description: "30 days" }),
    row("AT - BigTime", "20", 60),
    row("AT - iShare", "2", 9),
    row("AT - iShare", "1", 4.8),
    row("Vodafone", "1", 1),
  ])

  it("keeps only available rows with a size and a positive price, grouped by network", () => {
    expect(tables.MTN.map((r) => r.size)).toEqual(["500MB", "1GB", "2GB", "5GB"])
    expect(tables.MTN.map((r) => r.price)).toEqual([3, 5.5, 10, 22])
    expect(tables.Telecel).toHaveLength(2)
    expect(tables.AT).toHaveLength(3)
  })

  it("sorts AT by type (iShare first) then size", () => {
    expect(tables.AT.map(rowLabel)).toEqual(["AT iShare 1GB", "AT iShare 2GB", "AT BigTime 20GB"])
  })

  it("carries validity from the description", () => {
    expect(tables.Telecel.map(rowLabel)).toEqual(["Telecel 1GB (30 days)", "Telecel 10GB (No expiry)"])
  })

  it("only asks for the optional columns the rows have", () => {
    expect(tableColumns(tables.MTN)).toEqual({ type: false, validity: false })
    expect(tableColumns(tables.Telecel)).toEqual({ type: false, validity: true })
    expect(tableColumns(tables.AT)).toEqual({ type: true, validity: false })
  })

  it("never exposes a dealer price, even when the row carries one", () => {
    const t = buildPriceTables([{ ...row("MTN", "1", 5), dealer_price: 4 } as RawPackageRow])
    expect(t.MTN[0].price).toBe(5)
    expect(JSON.stringify(t)).not.toContain("dealer")
  })

  it("picks the cheapest row per network and AT type for the homepage", () => {
    expect(cheapestRows(tables).map(rowLabel)).toEqual([
      "MTN 500MB",
      "Telecel 1GB (30 days)",
      "AT iShare 1GB",
      "AT BigTime 20GB",
    ])
  })

  it("agrees with networkOf", () => {
    expect(networkOf("AT - iShare")).toBe("AT")
  })
})

describe("live facts dataPrices", () => {
  it("is built from the packages read", () => {
    const f = buildLiveFacts({ ...FAILED_RAW, packages: [row("MTN", "1", 5)] })
    expect(f.dataPrices?.MTN).toEqual([{ network: "MTN", size: "1GB", price: 5, type: null, validity: null }])
    expect(f.dataPrices?.AT).toEqual([])
  })
  it("is null when the packages read failed, so pages render without a table", () => {
    expect(buildLiveFacts(FAILED_RAW).dataPrices).toBeNull()
  })
})
