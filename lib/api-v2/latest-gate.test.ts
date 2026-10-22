import { describe, it, expect } from "vitest"
import { createLatestGate } from "./latest-gate"

describe("createLatestGate", () => {
  it("accepts the latest ticket", () => {
    const g = createLatestGate()
    const t = g.next()
    expect(g.isLatest(t)).toBe(true)
  })

  it("rejects an older ticket once a newer one has started, even if the older resolves last", () => {
    const g = createLatestGate()
    const older = g.next()
    const newer = g.next()
    expect(g.isLatest(newer)).toBe(true)
    expect(g.isLatest(older)).toBe(false)
  })

  it("gates are independent", () => {
    const a = createLatestGate()
    const b = createLatestGate()
    const ta = a.next()
    b.next()
    b.next()
    expect(a.isLatest(ta)).toBe(true)
  })
})
