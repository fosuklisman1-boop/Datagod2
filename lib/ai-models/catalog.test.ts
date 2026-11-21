import { describe, it, expect } from "vitest"
import { PROVIDER_MODELS, type ProviderName } from "@/lib/ai-provider-config"
import { MODEL_CATALOG, costPer1000Messages, formatCostPer1000, catalogFor } from "./catalog"

describe("costPer1000Messages", () => {
  it("uses 3000 in / 400 out tokens per message by default", () => {
    // 1000 * (3000*1 + 400*5) / 1e6 = 5.0
    expect(costPer1000Messages(1, 5)).toBeCloseTo(5, 6)
  })
  it("accepts custom token assumptions", () => {
    expect(costPer1000Messages(2, 10, { inTokens: 1000, outTokens: 100 })).toBeCloseTo(3, 6)
  })
  it("is null when either price is unknown", () => {
    expect(costPer1000Messages(null, 5)).toBeNull()
    expect(costPer1000Messages(1, null)).toBeNull()
  })
})

describe("formatCostPer1000", () => {
  it("rounds to cents", () => expect(formatCostPer1000(0.0314)).toBe("$0.03"))
  it("shows a dash for unknown", () => expect(formatCostPer1000(null)).toBe("—"))
})

describe("MODEL_CATALOG", () => {
  it("covers exactly the model ids in PROVIDER_MODELS", () => {
    for (const p of Object.keys(PROVIDER_MODELS) as ProviderName[]) {
      expect(catalogFor(p).map((m) => m.id).sort()).toEqual(PROVIDER_MODELS[p].map((m) => m.id).sort())
    }
  })
  it("has sourced, dated entries", () => {
    for (const p of Object.keys(MODEL_CATALOG) as ProviderName[]) {
      for (const m of MODEL_CATALOG[p]) {
        expect(m.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(m.sourceUrl).toMatch(/^https:\/\//)
        expect((m.inUsdPerM === null) === (m.outUsdPerM === null)).toBe(true)
      }
    }
  })
})
