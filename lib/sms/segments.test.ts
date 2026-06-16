import { describe, it, expect } from "vitest"
import { calculateSegments, calculateCredits } from "./segments"

describe("calculateSegments — GSM-7", () => {
  it("empty string → 1 segment, 0 chars, 160 remaining", () => {
    const r = calculateSegments("")
    expect(r.encoding).toBe("gsm7")
    expect(r.length).toBe(0)
    expect(r.segments).toBe(1)
    expect(r.remaining).toBe(160)
    expect(r.singleLimit).toBe(160)
  })

  it("159 chars → 1 segment, 1 remaining", () => {
    const r = calculateSegments("a".repeat(159))
    expect(r.encoding).toBe("gsm7")
    expect(r.segments).toBe(1)
    expect(r.remaining).toBe(1)
  })

  it("160 chars → 1 segment, 0 remaining (exact boundary)", () => {
    const r = calculateSegments("a".repeat(160))
    expect(r.encoding).toBe("gsm7")
    expect(r.segments).toBe(1)
    expect(r.remaining).toBe(0)
  })

  it("161 chars → 2 segments (crosses into multipart, limit drops to 153)", () => {
    const r = calculateSegments("a".repeat(161))
    expect(r.encoding).toBe("gsm7")
    expect(r.segments).toBe(2)
    // 161 chars / 153 per part = ceil → 2; remaining = 2*153 - 161 = 145
    expect(r.remaining).toBe(145)
    expect(r.singleLimit).toBe(160)
  })

  it("306 chars → 2 segments (153×2)", () => {
    const r = calculateSegments("a".repeat(306))
    expect(r.encoding).toBe("gsm7")
    expect(r.segments).toBe(2)
    expect(r.remaining).toBe(0)
  })

  it("307 chars → 3 segments", () => {
    const r = calculateSegments("a".repeat(307))
    expect(r.encoding).toBe("gsm7")
    expect(r.segments).toBe(3)
  })

  it("€ (extension char) counts as 2 GSM-7 code units", () => {
    // 158 plain chars + 1 '€' = 159 + 1 = 160 effective code units → 1 segment
    const r = calculateSegments("a".repeat(158) + "€")
    expect(r.encoding).toBe("gsm7")
    expect(r.segments).toBe(1)
    expect(r.length).toBe(160) // effective length (billing length)
  })

  it("€ that pushes over 160 → 2 segments (GSM-7 still, just multipart)", () => {
    // 159 plain + 1 '€' = 160 + 1 = 161 effective → 2 segments
    const r = calculateSegments("a".repeat(159) + "€")
    expect(r.encoding).toBe("gsm7")
    expect(r.segments).toBe(2)
  })

  it("{ and } are GSM-7 extension chars (count as 2 each)", () => {
    // 1 '{' = 2 effective code units; 158 plain + 1 '{' = 160 → still fits 1 segment
    const r = calculateSegments("a".repeat(158) + "{")
    expect(r.encoding).toBe("gsm7")
    expect(r.segments).toBe(1)
    expect(r.length).toBe(160)
  })
})

describe("calculateSegments — UCS-2 (Unicode)", () => {
  it("one emoji flips encoding to unicode", () => {
    const r = calculateSegments("Hello 🎉")
    expect(r.encoding).toBe("unicode")
    expect(r.singleLimit).toBe(70)
  })

  it("69 unicode chars → 1 segment, 1 remaining", () => {
    const r = calculateSegments("á".repeat(69))
    expect(r.encoding).toBe("unicode")
    expect(r.segments).toBe(1)
    expect(r.remaining).toBe(1)
  })

  it("70 unicode chars → 1 segment, 0 remaining (exact boundary)", () => {
    const r = calculateSegments("á".repeat(70))
    expect(r.encoding).toBe("unicode")
    expect(r.segments).toBe(1)
    expect(r.remaining).toBe(0)
  })

  it("71 unicode chars → 2 segments (multipart limit drops to 67)", () => {
    const r = calculateSegments("á".repeat(71))
    expect(r.encoding).toBe("unicode")
    expect(r.segments).toBe(2)
    // 2×67 = 134; 134 - 71 = 63 remaining
    expect(r.remaining).toBe(63)
  })

  it("emoji counts as 1 code point (not 2 UTF-16 surrogates)", () => {
    // 'a' × 69 + '🎉' (1 code point) = 70 code points → 1 segment
    const r = calculateSegments("a".repeat(69) + "🎉")
    expect(r.encoding).toBe("unicode")
    expect(r.segments).toBe(1)
    expect(r.length).toBe(70)
  })
})

describe("calculateCredits", () => {
  it("1 segment × 10 recipients = 10 credits", () => {
    expect(calculateCredits("hello", 10)).toBe(10)
  })

  it("2-segment message × 5 recipients = 10 credits", () => {
    // 161 GSM-7 chars = 2 segments
    expect(calculateCredits("a".repeat(161), 5)).toBe(10)
  })

  it("0 recipients = 0 credits", () => {
    expect(calculateCredits("hi", 0)).toBe(0)
  })
})
