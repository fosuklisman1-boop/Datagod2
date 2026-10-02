import { describe, it, expect } from "vitest"
import { resolveMenuItems, renderMenuText, keyForDigit, type MenuItemDef } from "./menu-items"

type Key = "a" | "b" | "c" | "d"

const ITEMS: MenuItemDef<Key>[] = [
  { key: "a", label: "Alpha" },
  { key: "b", label: "Beta" },
  { key: "c", label: "Gamma" },
  { key: "d", label: "Delta" },
]

describe("resolveMenuItems", () => {
  it("assigns sequential digits 1..N in order when everything is visible", () => {
    const resolved = resolveMenuItems(ITEMS, { a: true, b: true, c: true, d: true })
    expect(resolved).toEqual([
      { key: "a", digit: 1, label: "Alpha" },
      { key: "b", digit: 2, label: "Beta" },
      { key: "c", digit: 3, label: "Gamma" },
      { key: "d", digit: 4, label: "Delta" },
    ])
  })

  it("hides the right item and renumbers the rest: hiding the 2nd of 4 makes the 3rd item digit 2", () => {
    const resolved = resolveMenuItems(ITEMS, { a: true, b: false, c: true, d: true })
    expect(resolved).toEqual([
      { key: "a", digit: 1, label: "Alpha" },
      { key: "c", digit: 2, label: "Gamma" },
      { key: "d", digit: 3, label: "Delta" },
    ])
  })

  it("preserves original order with 2 of 4 hidden at mixed, non-edge positions (hide 1st and 3rd)", () => {
    // Hide "a" (1st) and "c" (3rd) — "b" and "d" keep their relative order,
    // renumbered to 1 and 2.
    const resolved = resolveMenuItems(ITEMS, { a: false, b: true, c: false, d: true })
    expect(resolved).toEqual([
      { key: "b", digit: 1, label: "Beta" },
      { key: "d", digit: 2, label: "Delta" },
    ])
  })

  it("preserves original order with 2 of 4 hidden at the opposite mixed positions (hide 2nd and 4th)", () => {
    const resolved = resolveMenuItems(ITEMS, { a: true, b: false, c: true, d: false })
    expect(resolved).toEqual([
      { key: "a", digit: 1, label: "Alpha" },
      { key: "c", digit: 2, label: "Gamma" },
    ])
  })
})

describe("renderMenuText", () => {
  it("renders header, numbered lines in order, then the footer", () => {
    const resolved = resolveMenuItems(ITEMS, { a: true, b: false, c: true, d: true })
    expect(renderMenuText("Welcome", resolved, "0. Exit")).toBe(
      "Welcome\n1. Alpha\n2. Gamma\n3. Delta\n0. Exit"
    )
  })
})

describe("keyForDigit", () => {
  it("returns the right key for a visible item's (renumbered) digit", () => {
    // b is hidden, so c is renumbered from digit 3 down to digit 2.
    const resolved = resolveMenuItems(ITEMS, { a: true, b: false, c: true, d: true })
    expect(keyForDigit(resolved, "2")).toBe("c")
  })

  it("returns null for a digit that doesn't match any visible item, including one that WOULD have mapped to something before it was hidden", () => {
    // Before hiding, "d" was digit 4. After hiding "b" (2nd of 4), the list
    // renumbers to only 3 items (a=1, c=2, d=3) — digit "4" now matches
    // nothing, even though a digit 4 existed in the unfiltered menu.
    const resolved = resolveMenuItems(ITEMS, { a: true, b: false, c: true, d: true })
    expect(resolved).toHaveLength(3)
    expect(keyForDigit(resolved, "4")).toBeNull()
  })

  it("returns null for non-numeric input", () => {
    const resolved = resolveMenuItems(ITEMS, { a: true, b: true, c: true, d: true })
    expect(keyForDigit(resolved, "abc")).toBeNull()
    expect(keyForDigit(resolved, "")).toBeNull()
  })

  it("returns null for \"0\" — 0 is never a menu item, callers handle Back/Exit separately", () => {
    const resolved = resolveMenuItems(ITEMS, { a: true, b: true, c: true, d: true })
    expect(keyForDigit(resolved, "0")).toBeNull()
  })
})
