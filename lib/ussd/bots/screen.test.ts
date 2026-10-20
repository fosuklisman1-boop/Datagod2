import { describe, it, expect } from "vitest"
import {
  UZO_SCREEN_LIMIT,
  uzoSafeLabel,
  uzoPagedList,
  uzoConfirmText,
  botErrorText,
  fitsUzo,
} from "./screen"

describe("uzoSafeLabel", () => {
  it.each([
    ["Data 1GB", "Internet 1GB"],
    ["Databundle", "Internet"],
    ["metadata", "metadata"],
    ["Data1", "Internet1"],
    ["Bundles", "Plan"],
    ["Social Bundle (7 days)", "Social (7 days)"],
    ["", "Plan"],
  ])("%s -> %s", (input, out) => {
    expect(uzoSafeLabel(input)).toBe(out)
  })

  it("never leaves data or bundle words", () => {
    const out = uzoSafeLabel("Big DATA bundles Data")
    expect(out).not.toMatch(/data|bundle/i)
  })
})

const longItems = Array.from({ length: 12 }, (_, i) => `Item${i + 1} ${"x".repeat(34)}`)

describe("uzoPagedList", () => {
  it("page 0 shows first items with More and Back", () => {
    const r = uzoPagedList(["A", "B", "C"], 0, (s) => s, { header: "Pick:", pageSize: 2 })
    expect(r.pageItems).toEqual(["A", "B"])
    expect(r.hasMore).toBe(true)
    expect(r.text).toBe("Pick:\n1. A\n2. B\n3. More...\n0. Back")
  })

  it("numbering continues across pages", () => {
    const r = uzoPagedList(["A", "B", "C", "D", "E"], 1, (s) => s, { header: "Pick:", pageSize: 2 })
    expect(r.pageItems).toEqual(["C", "D"])
    expect(r.text).toBe("Pick:\n3. C\n4. D\n5. More...\n0. Back")
  })

  it("last page has no More", () => {
    const r = uzoPagedList(["A", "B", "C"], 1, (s) => s, { header: "Pick:", pageSize: 2 })
    expect(r.pageItems).toEqual(["C"])
    expect(r.hasMore).toBe(false)
    expect(r.text).toBe("Pick:\n3. C\n0. Back")
  })

  it("a long label is cut on a word boundary, never mid-word", () => {
    const items = [1, 2, 3, 4, 5].map(i => `${i}0.50 ${i}GB Internet 30 Days`)
    const r = uzoPagedList([...items, "x"], 0, (s) => s, { header: "Yellow Plans Internet" })
    expect(r.text).toBe(
      "Yellow Plans Internet\n1. 10.50 1GB Internet\n2. 20.50 2GB Internet\n3. 30.50 3GB Internet\n" +
      "4. 40.50 4GB Internet\n5. 50.50 5GB Internet\n6. More...\n0. Back",
    )
  })

  it("a label with no space left in reach is hard-cut (still fits)", () => {
    const r = uzoPagedList(["Y".repeat(80), "Z".repeat(80)], 0, (s) => s, { header: "Pick:" })
    expect(fitsUzo(r.text)).toBe(true)
    expect(r.text.endsWith("0. Back")).toBe(true)
  })

  it("every page fits 160 with 40-char labels and keeps footer", () => {
    for (let page = 0; page < 3; page++) {
      const r = uzoPagedList(longItems, page, (s) => s.slice(0, 40), { header: "Select Plan:" })
      expect(r.text.length).toBeLessThanOrEqual(UZO_SCREEN_LIMIT)
      expect(r.text.endsWith("0. Back")).toBe(true)
      expect(r.text.endsWith("...")).toBe(false)
      if (page < 2) expect(r.text).toContain("More...")
    }
  })
})

describe("uzoConfirmText", () => {
  it("shows was when price is below face", () => {
    const t = uzoConfirmText({ pay: 9.5, face: 10, receive: "MTN 1GB", recipient: "0241234567", payer: "0241234567" })
    expect(t).toBe(
      "Pay GHS 9.50 (was GHS 10.00)\nYou get MTN 1GB\nTo: 0241234567\nMoMo: 0241234567\n1. Confirm\n2. Cancel"
    )
  })

  it("omits was when not below face, and To when no recipient", () => {
    const t = uzoConfirmText({ pay: 10, face: 10, receive: "MTN 1GB", payer: "0241234567" })
    expect(t).not.toContain("was")
    expect(t).not.toContain("To:")
    expect(t).toContain("MoMo: 0241234567")
  })

  it("long receive text still fits with footer intact", () => {
    const t = uzoConfirmText({
      pay: 9.5,
      face: 10,
      receive: "R".repeat(120),
      recipient: "0241234567",
      payer: "0241234567",
    })
    expect(t.length).toBeLessThanOrEqual(UZO_SCREEN_LIMIT)
    expect(t.endsWith("1. Confirm\n2. Cancel")).toBe(true)
    expect(fitsUzo(t)).toBe(true)
  })
})

describe("botErrorText", () => {
  it.each([
    [409, "Price changed. Please try again."],
    [429, "Too many attempts. Please try later."],
    [403, "Not available right now."],
    [500, "Service unavailable. Please try again later."],
    [400, "Service unavailable. Please try again later."],
  ])("%i", (status, text) => {
    expect(botErrorText(status)).toBe(text)
  })
})

describe("fitsUzo", () => {
  it("checks the 160 limit", () => {
    expect(fitsUzo("a".repeat(160))).toBe(true)
    expect(fitsUzo("a".repeat(161))).toBe(false)
  })
})
