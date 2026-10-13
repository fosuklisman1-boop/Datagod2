import { describe, it, expect } from "vitest"
import fixture from "@/lib/hubtel-cs/testing/fixtures/live-bundle-query-2026-10-13.json"
import type { HubtelQueryItem } from "@/lib/hubtel-cs/types"
import { CATEGORY_ORDER, NETWORK_SERVICE, categoryOf, parseCatalog, type BundleNetwork } from "./categories"

const live = fixture as unknown as Record<BundleNetwork, { Data: HubtelQueryItem[] }>

function counts(network: BundleNetwork) {
  const out: Record<string, number> = {}
  for (const b of parseCatalog(network, live[network].Data)) out[b.category] = (out[b.category] ?? 0) + 1
  return out
}

describe("live fixture categorisation", () => {
  it("MTN", () => {
    expect(parseCatalog("MTN", live.MTN.Data)).toHaveLength(37)
    expect(counts("MTN")).toEqual({ Data: 14, Video: 10, "Social Media": 8, Midnight: 4, Kokrokoo: 1 })
  })
  it("TELECEL", () => {
    expect(parseCatalog("TELECEL", live.TELECEL.Data)).toHaveLength(27)
    expect(counts("TELECEL")).toEqual({ "No Expiry": 11, Monthly: 8, Weekly: 3, Hourly: 2, Night: 2, Daily: 1 })
  })
  it("AT", () => {
    expect(parseCatalog("AT", live.AT.Data)).toHaveLength(30)
    expect(counts("AT")).toEqual({ BigTime: 12, Kokoo: 8, "Fuse (Mins + Data)": 7, "XXL Family": 3 })
  })
  it("never yields Other and respects category order then amount", () => {
    for (const n of ["MTN", "TELECEL", "AT"] as BundleNetwork[]) {
      const list = parseCatalog(n, live[n].Data)
      expect(list.some((b) => b.category === "Other")).toBe(false)
      const order = CATEGORY_ORDER[n]
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1], b = list[i]
        const ra = order.indexOf(a.category), rb = order.indexOf(b.category)
        expect(ra <= rb).toBe(true)
        if (ra === rb) expect(a.amount <= b.amount).toBe(true)
      }
    }
  })
  it("maps networks to services", () => {
    expect(NETWORK_SERVICE).toEqual({ MTN: "data_mtn", TELECEL: "data_telecel", AT: "data_at" })
  })
})

describe("edge cases", () => {
  it("unknown values go to Other, last", () => {
    expect(categoryOf("MTN", { Display: "x", Value: "mystery", Amount: 1 })).toBe("Other")
    expect(categoryOf("AT", { Display: "x", Value: "mystery", Amount: 1 })).toBe("Other")
    expect(categoryOf("TELECEL", { Display: "40 days - x", Value: "v", Amount: 1 })).toBe("Other")
    const list = parseCatalog("MTN", [
      { Display: "a", Value: "mystery", Amount: 1 },
      { Display: "b", Value: "RACT_Data_GHC_3_Others", Amount: 3 },
    ])
    expect(list.map((b) => b.category)).toEqual(["Data", "Other"])
  })
  it("keeps exact value with spaces, trims display", () => {
    const [b] = parseCatalog("TELECEL", [{ Display: "  1 Hour - 5.7GB  ", Value: " 5.7 GB", Amount: 2 }])
    expect(b.value).toBe(" 5.7 GB")
    expect(b.display).toBe("1 Hour - 5.7GB")
    expect(b.category).toBe("Hourly")
  })
  it("drops empty values and non-positive/non-finite amounts", () => {
    const list = parseCatalog("MTN", [
      { Display: "a", Value: "", Amount: 5 },
      { Display: "b", Value: "RACT_Data_x", Amount: -1 },
      { Display: "c", Value: "RACT_Data_x", Amount: 0 },
      { Display: "d", Value: "RACT_Data_x", Amount: NaN },
      { Display: "e", Value: "RACT_Data_x", Amount: Infinity },
      { Display: "f", Value: "RACT_Data_x", Amount: 2 },
    ])
    expect(list).toHaveLength(1)
    expect(list[0].amount).toBe(2)
  })
  it("keeps repeated MTN flexi value with different amounts", () => {
    const flexi = parseCatalog("MTN", live.MTN.Data).filter((b) => b.value === "RACT_Data_Flexi_Bundle")
    expect(flexi.length).toBeGreaterThan(1)
    expect(new Set(flexi.map((b) => b.amount)).size).toBe(flexi.length)
  })
})
