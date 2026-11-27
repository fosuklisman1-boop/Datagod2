import { describe, it, expect } from "vitest"
import { buildPersonaPrompt } from "./prompt"
import { maskForVoice } from "./mask"

const CONTEXTS = ["home", "storefront", "dashboard", "admin"] as const

describe("buildPersonaPrompt", () => {
  it("contains the assistant name", () => {
    expect(buildPersonaPrompt({ assistantName: "Clings", context: "home" })).toContain("Clings")
  })
  for (const context of CONTEXTS) {
    it(`is short, masked-clean and ASCII for ${context}`, () => {
      const out = buildPersonaPrompt({ assistantName: "Clings", context })
      expect(out.length).toBeLessThan(2500)
      expect(maskForVoice(out)).toBe(out)
      expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(out)).toBe(true)
    })
  }
  it("includes the key rules", () => {
    const out = buildPersonaPrompt({ assistantName: "Clings", context: "dashboard" })
    expect(out).toContain("hand")
    expect(out).toContain("never ask for")
    expect(out).toContain("card on your screen")
  })
  it("is deterministic", () => {
    const p = { assistantName: "Clings", context: "storefront", tone: "friendly" } as const
    expect(buildPersonaPrompt(p)).toBe(buildPersonaPrompt(p))
  })
  it("admin differs from home", () => {
    expect(buildPersonaPrompt({ assistantName: "Clings", context: "admin" }))
      .not.toBe(buildPersonaPrompt({ assistantName: "Clings", context: "home" }))
  })
})
