import { describe, it, expect } from "vitest"
import { maskName } from "./mask"

describe("maskName", () => {
  it("keeps the first 3 letters of each word", () => {
    expect(maskName("KLINSMAN FOSU BOATENG")).toBe("KLI*** FOS*** BOA***")
  })
  it("words of 3 letters or fewer keep only the first letter", () => {
    expect(maskName("ABA K. JOHN")).toBe("A*** K*** JOH***")
    expect(maskName("Ama")).toBe("A***")
    expect(maskName("Kofi")).toBe("Kof***")
  })
  it("collapses whitespace; null/empty stays null", () => {
    expect(maskName("  JOHN   DOE ")).toBe("JOH*** D***")
    expect(maskName("")).toBeNull()
    expect(maskName("   ")).toBeNull()
    expect(maskName(null)).toBeNull()
    expect(maskName(undefined)).toBeNull()
  })
})
