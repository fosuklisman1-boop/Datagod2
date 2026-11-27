import { describe, it, expect } from "vitest"
import { maskForVoice, clampForAppend } from "./mask"

describe("maskForVoice", () => {
  it("masks a local phone number to its last three digits", () => {
    expect(maskForVoice("Sent to 0241234567")).toBe("Sent to number ending 567")
  })
  it("masks an international phone with spaces and plus", () => {
    expect(maskForVoice("call +233 24 123 4567 now")).toBe("call number ending 567 now")
  })
  it("masks a dashed phone number", () => {
    expect(maskForVoice("024-123-4567")).toBe("number ending 567")
  })
  it("masks unicode-dashed phone numbers", () => {
    expect(maskForVoice("024–123–4567")).toBe("number ending 567")
  })
  it("masks spelled-out digit runs", () => {
    expect(maskForVoice("zero two four one two three four five six seven")).toBe("[number]")
  })
  it("masks other 7+ digit runs generically", () => {
    expect(maskForVoice("Order 12345678 is done")).toBe("Order [number] is done")
  })
  it("keeps dates and times", () => {
    expect(maskForVoice("on 2026-11-27 at 10:30")).toBe("on 2026-11-27 at 10:30")
  })
  it("keeps amounts and bundle sizes", () => {
    expect(maskForVoice("GHS 1,250.50 for 2GB or 1000MB")).toBe("GHS 1,250.50 for 2GB or 1000MB")
  })
  it("keeps short numbers", () => {
    expect(maskForVoice("ref 123456")).toBe("ref 123456")
  })
  it("keeps a trailing sentence period after a masked phone", () => {
    expect(maskForVoice("Call 0241234567.")).toBe("Call number ending 567.")
  })
})

describe("clampForAppend", () => {
  it("clamps to the max length", () => {
    expect(clampForAppend("a ".repeat(1500)).length).toBeLessThanOrEqual(2000)
  })
  it("never leaves a 7+ digit run, even at the cut", () => {
    expect(clampForAppend("x".repeat(1995) + " 0241234567")).not.toMatch(/\d{7}/)
  })
})
