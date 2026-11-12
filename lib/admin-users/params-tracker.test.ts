import { describe, it, expect } from "vitest"
import { createParamsTracker } from "./params-tracker"
import { DEFAULT_FILTERS, DEFAULT_PAGE_SIZE, listParamsToSearchParams, type UsersListParams } from "./list-params"

const base: UsersListParams = { ...DEFAULT_FILTERS, page: 3, pageSize: DEFAULT_PAGE_SIZE }
const key = (p: UsersListParams) => listParamsToSearchParams(p).toString()

describe("createParamsTracker", () => {
  it("applies each change on top of the previous one even before the URL catches up (debounced search vs filter click)", () => {
    const t = createParamsTracker(base)
    const a = t.apply({ role: "dealer" })       // filter click: URL not updated yet
    const b = t.apply({ q: "ama" })             // debounced search fires right after
    expect(a).toMatchObject({ role: "dealer", page: 1 })
    expect(b).toMatchObject({ role: "dealer", q: "ama", page: 1 })
  })

  it("ignores the URL catching up to an older push, then follows the latest", () => {
    const t = createParamsTracker(base)
    const a = t.apply({ role: "dealer" })
    const b = t.apply({ q: "ama" })
    t.urlChanged(a)                              // the first replace lands
    expect(t.current()).toEqual(b)
    t.urlChanged(b)
    expect(key(t.current())).toBe(key(b))
    // later changes still build on b
    expect(t.apply({ suspended: true })).toMatchObject({ role: "dealer", q: "ama", suspended: true })
  })

  it("follows outside URL changes (back/forward) when nothing is pending", () => {
    const t = createParamsTracker(base)
    const elsewhere = { ...base, role: "admin" as const, page: 7 }
    t.urlChanged(elsewhere)
    expect(t.current()).toEqual(elsewhere)
  })

  it("page changes keep the page; filter changes reset to 1; reversed dates are swapped", () => {
    const t = createParamsTracker(base)
    expect(t.apply({ page: 5 }, { keepPage: true }).page).toBe(5)
    expect(t.apply({ from: "2026-05-01", to: "2026-04-01" })).toMatchObject({ from: "2026-04-01", to: "2026-05-01", page: 1 })
  })
})
