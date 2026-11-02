import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabase: {}, supabaseAdmin: {} }))
vi.mock("../supabase", () => ({ supabase: {}, supabaseAdmin: {} }))

import { parseSizeGb, buildPriceGroups, DASHBOARD_NETWORKS } from "./data-prices"

const ADJ = {
  price_adjustment_mtn: 10,
  price_adjustment_telecel: 0,
  price_adjustment_at_ishare: 0,
  price_adjustment_at_bigtime: 0,
}

describe("parseSizeGb", () => {
  it("parses GB and MB (1000 MB = 1 GB)", () => {
    expect(parseSizeGb("1GB")).toBe(1)
    expect(parseSizeGb("1.5 gb")).toBe(1.5)
    expect(parseSizeGb("500MB")).toBe(0.5)
    expect(parseSizeGb("2000MB")).toBe(2)
  })
  it("treats a bare number as GB (the platform stores sizes without a unit)", () => {
    expect(parseSizeGb("1")).toBe(1)
    expect(parseSizeGb("1.5")).toBe(1.5)
    expect(parseSizeGb("1 gb")).toBe(1)
    expect(parseSizeGb(" 10 ")).toBe(10)
  })
  it("returns null for anything else", () => {
    expect(parseSizeGb("Unlimited")).toBeNull()
    expect(parseSizeGb("")).toBeNull()
    expect(parseSizeGb(null)).toBeNull()
    expect(parseSizeGb(undefined)).toBeNull()
  })
})

describe("buildPriceGroups", () => {
  const row = (network: string, size: string | null, price: number | string | null, is_available: boolean | null = true) => ({
    network, size, price, is_available,
  })

  it("applies the network adjustment", () => {
    const g = buildPriceGroups([row("MTN", "1GB", 5)], ADJ)
    expect(g.MTN).toEqual([{ network: "MTN", rows: [{ size: "1GB", label: "1GB", price: 5.5, gb: 1, perGb: 5.5 }] }])
    expect(g.Telecel).toEqual([])
    expect(g.AT).toEqual([])
  })

  it("keeps the cheapest of duplicate (network, size) rows", () => {
    const g = buildPriceGroups([row("MTN", "1GB", 6), row("MTN", "1GB", 5)], ADJ)
    expect(g.MTN[0].rows).toEqual([{ size: "1GB", label: "1GB", price: 5.5, gb: 1, perGb: 5.5 }])
  })

  it("drops rows whose adjusted price is <= 0", () => {
    const g = buildPriceGroups([row("MTN", "1GB", 5)], { ...ADJ, price_adjustment_mtn: -100 })
    expect(g.MTN).toEqual([])
  })

  it("drops non-finite, null and unavailable rows", () => {
    const g = buildPriceGroups(
      [row("MTN", "1GB", null), row("MTN", "2GB", "abc"), row("MTN", "3GB", 9, false), row("MTN", "4GB", 9, null)],
      ADJ,
    )
    expect(g.MTN).toEqual([])
  })

  it("makes two AT groups, each with its own adjustment column", () => {
    const g = buildPriceGroups(
      [row("AT - iShare", "1GB", 10), row("AT - BigTime", "1GB", 10)],
      { ...ADJ, price_adjustment_at_ishare: 10, price_adjustment_at_bigtime: 20 },
    )
    expect(g.AT.map((x) => x.network)).toEqual(["AT - BigTime", "AT - iShare"])
    expect(g.AT.find((x) => x.network === "AT - iShare")!.rows[0].price).toBe(11)
    expect(g.AT.find((x) => x.network === "AT - BigTime")!.rows[0].price).toBe(12)
  })

  it("computes perGb for MB sizes", () => {
    const g = buildPriceGroups([row("Telecel", "500MB", 3)], ADJ)
    expect(g.Telecel[0].rows[0]).toEqual({ size: "500MB", label: "500MB", price: 3, gb: 0.5, perGb: 6 })
  })

  it("sorts rows by gb asc, null gb last", () => {
    const g = buildPriceGroups(
      [row("Telecel", "Unlimited", 50), row("Telecel", "5GB", 20), row("Telecel", "1GB", 5), row("Telecel", "500MB", 3)],
      ADJ,
    )
    expect(g.Telecel[0].rows.map((r) => r.size)).toEqual(["500MB", "1GB", "5GB", "Unlimited"])
    expect(g.Telecel[0].rows[3]).toMatchObject({ gb: null, perGb: null })
  })

  it("reads bare-number sizes: label, gb and perGb", () => {
    const g = buildPriceGroups([row("MTN", "1", 5), row("MTN", "1.5", 9), row("MTN", "2", 10)], ADJ)
    expect(g.MTN[0].rows).toEqual([
      { size: "1", label: "1GB", price: 5.5, gb: 1, perGb: 5.5 },
      { size: "1.5", label: "1.5GB", price: 9.9, gb: 1.5, perGb: 6.6 },
      { size: "2", label: "2GB", price: 11, gb: 2, perGb: 5.5 },
    ])
  })

  it("dedupes '1', '1GB' and '1 GB' into one row; cheapest wins", () => {
    const g = buildPriceGroups([row("Telecel", "1", 6), row("Telecel", "1GB", 5), row("Telecel", "1 GB", 7)], ADJ)
    expect(g.Telecel[0].rows).toHaveLength(1)
    expect(g.Telecel[0].rows[0]).toMatchObject({ label: "1GB", price: 5, gb: 1, perGb: 5 })
  })

  it("labels MB and unparseable sizes", () => {
    const g = buildPriceGroups([row("Telecel", "500MB", 3), row("Telecel", " Weekly ", 9)], ADJ)
    expect(g.Telecel[0].rows[0]).toMatchObject({ label: "500MB", gb: 0.5 })
    expect(g.Telecel[0].rows[1]).toMatchObject({ label: "Weekly", gb: null, perGb: null })
  })

  it("only accepts the dashboard's exact network keys", () => {
    expect(DASHBOARD_NETWORKS).toEqual(["MTN", "Telecel", "AT - iShare", "AT - BigTime"])
    const g = buildPriceGroups(
      [row("AT-iShare", "1", 5), row("AirtelTigo", "1", 5), row("mtn", "1", 5), row("AT - iShare", "1", 5)],
      ADJ,
    )
    expect(g.MTN).toEqual([])
    expect(g.AT.map((x) => x.network)).toEqual(["AT - iShare"])
  })

  it("ignores unknown networks", () => {
    const g = buildPriceGroups([row("Vodafone", "1GB", 5)], ADJ)
    expect(g).toEqual({ MTN: [], Telecel: [], AT: [] })
  })
})
