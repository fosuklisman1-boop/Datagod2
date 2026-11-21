import { describe, it, expect } from "vitest"
import { selectionReducer, emptySelection, SELECTION_CAP, type SelectionState } from "./selection"

const s = (ids: string[], allMatching = false): SelectionState => ({ ids: new Set(ids), allMatching })

describe("selectionReducer", () => {
  it("toggle adds then removes an id", () => {
    const on = selectionReducer(emptySelection(), { type: "toggle", id: "a" })
    expect([...on.ids]).toEqual(["a"])
    const off = selectionReducer(on, { type: "toggle", id: "a" })
    expect(off.ids.size).toBe(0)
  })
  it("toggle does not mutate the previous state", () => {
    const prev = s(["a"])
    selectionReducer(prev, { type: "toggle", id: "b" })
    expect([...prev.ids]).toEqual(["a"])
  })
  it("toggle drops 'all matching' (the admin is now picking by hand)", () => {
    const next = selectionReducer(s(["a", "b"], true), { type: "toggle", id: "a" })
    expect(next.allMatching).toBe(false)
    expect([...next.ids]).toEqual(["b"])
  })
  it("selectPage adds the page ids to what is already selected", () => {
    const next = selectionReducer(s(["x"]), { type: "selectPage", ids: ["a", "b", "x"] })
    expect([...next.ids].sort()).toEqual(["a", "b", "x"])
  })
  it("clear empties everything", () => {
    const next = selectionReducer({ ids: new Set(["a"]), allMatching: true, error: "cap" }, { type: "clear" })
    expect(next.ids.size).toBe(0)
    expect(next.allMatching).toBe(false)
    expect(next.error).toBeUndefined()
  })
  it("selectAllMatching within the cap sets allMatching", () => {
    const next = selectionReducer(s(["a"]), { type: "selectAllMatching", total: SELECTION_CAP })
    expect(next.allMatching).toBe(true)
    expect(next.error).toBeUndefined()
  })
  it("selectAllMatching(201) leaves ids unchanged and sets error 'cap'", () => {
    const prev = s(["a", "b"])
    const next = selectionReducer(prev, { type: "selectAllMatching", total: 201 })
    expect(next.error).toBe("cap")
    expect(next.allMatching).toBe(false)
    expect([...next.ids]).toEqual(["a", "b"])
  })
  it("cap is 200", () => {
    expect(SELECTION_CAP).toBe(200)
  })
})
