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

describe("current DeepSeek models (R6) and tools badges", () => {
  const find = (p: ProviderName, id: string) => catalogFor(p).find((m) => m.id === id)!
  it("lists deepseek-flash and deepseek-v4-pro with off-peak prices and a peak note", () => {
    const f = find("deepseek", "deepseek-flash"), v = find("deepseek", "deepseek-v4-pro")
    expect([f.inUsdPerM, f.outUsdPerM]).toEqual([0.15, 0.6])
    expect([v.inUsdPerM, v.outUsdPerM]).toEqual([0.66, 1.98])
    expect(f.tools && v.tools).toBe(true)
    expect(f.note).toMatch(/Off-peak price/)
  })
  it("keeps legacy aliases unpriced and relabelled", () => {
    for (const id of ["deepseek-chat", "deepseek-reasoner"]) {
      const m = find("deepseek", id)
      expect(m.label).toMatch(/legacy alias/)
      expect(m.inUsdPerM).toBeNull()
    }
  })
  it("marks OpenAI and Gemini 2.5 Pro as tool-capable", () => {
    for (const id of ["gpt-4o-mini", "gpt-4o", "gpt-4.1"]) expect(find("openai", id).tools).toBe(true)
    expect(find("gemini", "gemini-2.5-pro").tools).toBe(true)
  })
})

describe("gemma2 retirement note", () => {
  it("is labelled as possibly retired and unpriced, id kept", () => {
    const m = MODEL_CATALOG.groq.find((x) => x.id === "gemma2-9b-it")!
    expect(m.label).toBe("Gemma 2 9B (may be retired)")
    expect(m.inUsdPerM).toBeNull()
    expect(m.outUsdPerM).toBeNull()
    expect(PROVIDER_MODELS.groq.find((x) => x.id === "gemma2-9b-it")!.label).toBe("Gemma 2 9B (may be retired)")
  })
})
