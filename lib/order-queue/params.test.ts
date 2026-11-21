import { describe, it, expect } from "vitest"
import { parseQueueParams, queueParamsToSearch } from "./params"

const parse = (q: string) => parseQueueParams(new URLSearchParams(q))

describe("parseQueueParams", () => {
  it("applies defaults", () => {
    const r = parse("")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.view).toBe("needs_action")
    expect(r.value.limit).toBe(50)
    expect(r.value.offset).toBe(0)
    expect(r.value.statuses).toEqual([])
    expect(r.value.search).toBe("")
    expect(r.value.failureReason).toBeNull()
  })
  it("rejects unknown view, type and reason", () => {
    expect(parse("view=bogus").ok).toBe(false)
    expect(parse("types=bulk,nope").ok).toBe(false)
    expect(parse("failureReason=nope").ok).toBe(false)
  })
  it("clamps limit to 200 and offset to >= 0", () => {
    const r = parse("limit=999&offset=-5")
    expect(r.ok && r.value.limit).toBe(200)
    expect(r.ok && r.value.offset).toBe(0)
  })
  it("rejects non-ISO dates", () => {
    expect(parse("from=1").ok).toBe(false)
    expect(parse("to=foo%2012").ok).toBe(false)
    expect(parse("from=2026-11-01T00:00:00Z").ok).toBe(true)
    expect(parse("from=2026-11-01T00:00:00%2B02:00").ok).toBe(true)
  })
  it("caps offset at 1,000,000", () => {
    const r = parse("offset=99999999999")
    expect(r.ok && r.value.offset).toBe(1_000_000)
  })
  it("trims search to 100 chars", () => {
    const r = parse("search=" + encodeURIComponent("  " + "a".repeat(150)))
    expect(r.ok && r.value.search).toBe("a".repeat(100))
  })
  it("round-trips through queueParamsToSearch", () => {
    const p = parse(
      "view=failed&statuses=failed,pending&networks=MTN,AT&types=bulk,shop&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&search=abc&lastProvider=hubnet&failureReason=rejected&limit=25&offset=50",
    )
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const back = parse(queueParamsToSearch(p.value))
    expect(back.ok && back.value).toEqual(p.value)
  })
  it("round-trips defaults", () => {
    const p = parse("")
    if (!p.ok) throw new Error("x")
    const back = parse(queueParamsToSearch(p.value))
    expect(back.ok && back.value).toEqual(p.value)
  })
})
