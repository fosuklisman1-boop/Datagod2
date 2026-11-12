import { describe, it, expect } from "vitest"
import { removeIds, setSelected, setSelectedMany } from "./selection"

describe("selection", () => {
  it("adds and removes one id without mutating", () => {
    const a = new Set(["x"])
    const b = setSelected(a, "y", true)
    expect([...b]).toEqual(["x", "y"])
    expect([...a]).toEqual(["x"])
    expect([...setSelected(b, "x", false)]).toEqual(["y"])
  })
  it("selects / clears a whole page", () => {
    expect([...setSelectedMany(new Set(["z"]), ["a", "b"], true)].sort()).toEqual(["a", "b", "z"])
    expect([...setSelectedMany(new Set(["a", "b", "z"]), ["a", "b"], false)]).toEqual(["z"])
  })
  it("drops deleted users", () => {
    const s = new Set(["a", "b"])
    expect([...removeIds(s, ["a"])]).toEqual(["b"])
    expect(removeIds(s, ["nope"])).toBe(s) // unchanged set is returned as-is (no re-render)
  })
})
