import { describe, it, expect } from "vitest"
import { clip, fitListScreen, noProductWords, pageSlice } from "./screen-fit"
import { USSD_SCREEN_LIMIT } from "./protocol"

describe("noProductWords", () => {
  it("rewrites data and drops bundle words", () => {
    expect(noProductWords("Data")).toBe("Internet")
    expect(noProductWords("Fuse (Mins + Data)")).toBe("Fuse (Mins + Internet)")
    expect(noProductWords("Kokrokoo Bundle 400MB")).toBe("Kokrokoo 400MB")
    expect(noProductWords("DATA bundles 1GB")).toBe("Internet 1GB")
    expect(noProductWords("Video 1.33GB")).toBe("Video 1.33GB")
  })
  it("never leaves a product word", () => {
    for (const s of ["data", "Databundle", "MTN Data Bundle", "bundles", "DATA_x", "1GB data"]) {
      expect(noProductWords(s)).not.toMatch(/data|bundle/i)
    }
  })
  it("leaves words that merely contain 'data' alone", () => {
    expect(noProductWords("metadata")).toBe("metadata")
  })
  it("falls back to 'Plan' when nothing is left", () => {
    expect(noProductWords("Bundle")).toBe("Plan")
    expect(noProductWords("  bundles  ")).toBe("Plan")
    expect(noProductWords("")).toBe("Plan")
  })
})

describe("pageSlice", () => {
  const all = Array.from({ length: 12 }, (_, i) => i + 1)
  it("pages 5 per screen", () => {
    expect(pageSlice(all, 0, 5)).toEqual({ items: [1, 2, 3, 4, 5], page: 0, hasNext: true, hasPrev: false })
    expect(pageSlice(all, 1, 5)).toEqual({ items: [6, 7, 8, 9, 10], page: 1, hasNext: true, hasPrev: true })
    expect(pageSlice(all, 2, 5)).toEqual({ items: [11, 12], page: 2, hasNext: false, hasPrev: true })
  })
  it("clamps an out-of-range page", () => {
    expect(pageSlice(all, 9, 5).page).toBe(2)
    expect(pageSlice(all, -1, 5).page).toBe(0)
    expect(pageSlice([], 3, 5)).toEqual({ items: [], page: 0, hasNext: false, hasPrev: false })
    expect(pageSlice([1, 2, 3, 4, 5], 0, 5).hasNext).toBe(false)
  })
})

describe("fitListScreen", () => {
  it("renders untouched when it fits", () => {
    expect(fitListScreen("MTN Video", [{ label: "Video 1GB", suffix: "GHS 9.50" }], ["0 Next", "00 Back"]))
      .toBe("MTN Video\n1. Video 1GB GHS 9.50\n0 Next\n00 Back")
  })
  it("shortens long labels to stay within 182, keeping prices and footer whole", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ label: `Very long plan description number ${i} with extras`.repeat(2), suffix: `GHS ${i + 10}.00` }))
    const text = fitListScreen("MTN Social Media", items, ["0 Next", "00 Back"])
    expect(text.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
    expect(text.endsWith("0 Next\n00 Back")).toBe(true)
    for (let i = 0; i < 5; i++) expect(text).toContain(`GHS ${i + 10}.00`)
    expect(text.split("\n")).toHaveLength(8)
  })
  it("cuts at the limit when even the fixed parts do not fit", () => {
    const text = fitListScreen("H".repeat(300), [{ label: "a" }], ["00 Back"])
    expect(text.length).toBe(USSD_SCREEN_LIMIT)
  })
  it("respects a custom limit", () => {
    expect(fitListScreen("", [{ label: "abcdefghij" }, { label: "abc" }], [], 12).length).toBeLessThanOrEqual(12)
  })
})

describe("clip", () => {
  it("clips to max", () => {
    expect(clip("hello world", 5)).toBe("hello")
    expect(clip("hi", 5)).toBe("hi")
  })
})
