import { describe, it, expect } from "vitest"
import { MAX_TAG_CHANGES, NOTE_MAX_LENGTH, SUGGESTED_TAGS, normaliseTag, parseNoteBody, parseTagsChange } from "./notes-tags"

describe("normaliseTag", () => {
  it("trims and lower-cases valid tags", () => {
    expect(normaliseTag(" VIP ")).toBe("vip")
    expect(normaliseTag("fraud-watch")).toBe("fraud-watch")
    expect(normaliseTag("a".repeat(32))).toBe("a".repeat(32))
  })
  it("rejects anything outside [a-z0-9-]{1,32}", () => {
    for (const bad of ["", "  ", "has space", "under_score", "a".repeat(33), "émoji", 3, null, undefined]) expect(normaliseTag(bad), String(bad)).toBeNull()
  })
  it("every suggested tag is valid", () => {
    expect(SUGGESTED_TAGS).toEqual(["vip", "fraud-watch", "bulk-buyer", "reseller", "support-priority"])
    for (const t of SUGGESTED_TAGS) expect(normaliseTag(t)).toBe(t)
  })
})

describe("parseTagsChange", () => {
  it("normalises and de-duplicates", () => {
    expect(parseTagsChange({ add: ["VIP", "vip", "reseller"], remove: ["old-tag"] })).toEqual({ ok: true, change: { add: ["vip", "reseller"], remove: ["old-tag"] } })
  })
  it("refuses empty, invalid, contradictory and oversized changes", () => {
    expect(parseTagsChange({}).ok).toBe(false)
    expect(parseTagsChange(null).ok).toBe(false)
    expect(parseTagsChange({ add: "vip" }).ok).toBe(false)
    expect(parseTagsChange({ add: ["bad tag"] }).ok).toBe(false)
    expect(parseTagsChange({ add: ["vip"], remove: ["VIP"] }).ok).toBe(false)
    expect(parseTagsChange({ add: Array.from({ length: MAX_TAG_CHANGES + 1 }, (_, i) => `t${i}`) }).ok).toBe(false)
  })
})

describe("parseNoteBody", () => {
  it("trims; 1..2000 characters (code points)", () => {
    expect(parseNoteBody("  hello  ")).toEqual({ ok: true, body: "hello" })
    expect(parseNoteBody("   ").ok).toBe(false)
    expect(parseNoteBody(42).ok).toBe(false)
    expect(parseNoteBody("x".repeat(NOTE_MAX_LENGTH)).ok).toBe(true)
    expect(parseNoteBody("x".repeat(NOTE_MAX_LENGTH + 1)).ok).toBe(false)
    // 2000 emoji are 4000 UTF-16 units but 2000 characters, as Postgres counts them
    expect(parseNoteBody("😀".repeat(NOTE_MAX_LENGTH)).ok).toBe(true)
  })
})
