import { describe, it, expect } from "vitest"
import { CODE_LETTERS, CODE_DIGITS, generateClaimCode, scanCodeCandidates } from "./codes"

describe("generateClaimCode", () => {
  it("always matches the code shape", () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateClaimCode()).toMatch(/^[A-HJKMNP-Z]{3}[2-9]{4}$/)
    }
  })

  it("uses the injected randomInt", () => {
    const calls: number[] = []
    const code = generateClaimCode((max) => {
      calls.push(max)
      return 0
    })
    expect(code).toBe(`${CODE_LETTERS[0]!.repeat(3)}${CODE_DIGITS[0]!.repeat(4)}`)
    expect(calls).toEqual([
      CODE_LETTERS.length, CODE_LETTERS.length, CODE_LETTERS.length,
      CODE_DIGITS.length, CODE_DIGITS.length, CODE_DIGITS.length, CODE_DIGITS.length,
    ])
  })
})

describe("scanCodeCandidates", () => {
  it("finds a code case-insensitively with a space", () => {
    expect(scanCodeCandidates("Ref kxr 4829 thanks")).toEqual(["KXR4829"])
  })
  it("accepts a hyphen", () => {
    expect(scanCodeCandidates("KXR-4829")).toEqual(["KXR4829"])
  })
  it("accepts no separator", () => {
    expect(scanCodeCandidates("pay KXR4829 now")).toEqual(["KXR4829"])
  })
  it("ignores lookalike characters O and 0", () => {
    expect(scanCodeCandidates("KOR 4829")).toEqual([])
    expect(scanCodeCandidates("KXR 4O29")).toEqual([])
    expect(scanCodeCandidates("KXR 4029")).toEqual([])
  })
  it("never returns a code adjacent to longer runs", () => {
    expect(scanCodeCandidates("XKXR48299")).toEqual([])
    expect(scanCodeCandidates("XKXR4829")).toEqual([])
    expect(scanCodeCandidates("KXR48299")).toEqual([])
  })
  it("returns unique values in order of appearance", () => {
    expect(scanCodeCandidates("ZZZ2222, abc 3333, ZZZ-2222")).toEqual(["ZZZ2222", "ABC3333"])
  })
})
