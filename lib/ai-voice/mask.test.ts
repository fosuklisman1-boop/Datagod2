import { describe, it, expect } from "vitest"
import { maskForVoice, clampForAppend, toVoiceText } from "./mask"

describe("toVoiceText", () => {
  it("maps currency, quotes, dashes and drops emoji", () => {
    expect(toVoiceText("₵5 — “ok” 😀")).toBe('GHS 5 - "ok"')
    expect(toVoiceText("GH₵10 it’s… fine – yes")).toBe("GHS 10 it's... fine - yes")
  })
  it("strips markdown", () => {
    expect(toVoiceText("# Title\n- **bold** item\n* __x__ [link](https://a.b/c)")).toBe(
      "Title bold item x link",
    )
  })
  it("always returns printable ASCII", () => {
    expect(toVoiceText("café ✓ 日本")).toMatch(/^[\x20-\x7E]*$/)
  })
})

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

describe("maskForVoice fix round 1", () => {
  it.each(["024,123,4567", "024/123/4567", "024_123_4567", "024:123:4567"])(
    "masks phone written as %s",
    (p) => {
      expect(maskForVoice(p)).toBe("number ending 567")
    },
  )
  it("keeps thousands-style amounts and times", () => {
    expect(maskForVoice("GHS 1,250,000 and 1,250,000.50 at 10:30")).toBe(
      "GHS 1,250,000 and 1,250,000.50 at 10:30",
    )
  })
  it("does not join comma-separated list items", () => {
    expect(maskForVoice("items 12, 13, 14, 15")).toBe("items 12, 13, 14, 15")
  })
  it("counts digits and digit words together", () => {
    const out = maskForVoice("0 2 4 one two three four five six")
    expect(out).not.toMatch(/\d{3}/)
    expect(out).toContain("[number]")
  })
  it("counts oh and double as digit words", () => {
    expect(maskForVoice("oh two four double one two three four")).toBe("[number]")
  })
  it("keeps short mixed runs", () => {
    expect(maskForVoice("pick 2 or three of 4")).toBe("pick 2 or three of 4")
  })
})

describe("maskForVoice final review: spaced separators", () => {
  it.each(["024 / 123 / 4567", "024, 123, 4567", "024 | 123 | 4567", "024 : 123 : 4567", "024 ,123 ,4567"])(
    "masks a phone written as %s",
    (p) => {
      expect(maskForVoice(`call ${p} now`)).toBe("call number ending 567 now")
    },
  )
  it("masks an international phone written with spaced commas", () => {
    expect(maskForVoice("233, 241, 234, 567")).toBe("number ending 567")
  })
  it("masks any 7+ digit stream of groups of 3+ digits", () => {
    expect(maskForVoice("code 1234, 5678, 9012")).toBe("code [number]")
    expect(maskForVoice("ids 123 / 456 / 789")).toBe("ids [number]")
  })
  it("keeps short lists and small groups", () => {
    expect(maskForVoice("pick 1, 2, 5, 10")).toBe("pick 1, 2, 5, 10")
    expect(maskForVoice("items 12, 13, 14, 15")).toBe("items 12, 13, 14, 15")
    expect(maskForVoice("page 1 / 12, 3 / 4")).toBe("page 1 / 12, 3 / 4")
  })
  it("keeps a short group list (under 7 digits) and amounts", () => {
    expect(maskForVoice("100, 200")).toBe("100, 200")
    expect(maskForVoice("GHS 1,250,000 and 250,000,000")).toBe("GHS 1,250,000 and 250,000,000")
  })
  it("keeps dates and times next to such streams", () => {
    expect(maskForVoice("on 2026-11-27 at 10:30, 11:30")).toBe("on 2026-11-27 at 10:30, 11:30")
  })
  it("a masked phone with spaced separators never leaves digits in the clamp", () => {
    expect(clampForAppend("call 024 / 123 / 4567")).toBe("call number ending 567")
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
