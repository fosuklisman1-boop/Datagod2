import { describe, it, expect } from "vitest"
import { nextNavVisible, shouldForceNavVisible } from "./scroll-direction"

describe("shouldForceNavVisible", () => {
  it("forces visible when not scrollable", () => {
    expect(shouldForceNavVisible({ scrollable: false, currentY: 400, topOffset: 16 })).toBe(true)
  })
  it("forces visible at the top", () => {
    expect(shouldForceNavVisible({ scrollable: true, currentY: 10, topOffset: 16 })).toBe(true)
  })
  it("does not force when scrolled down in a scrollable page", () => {
    expect(shouldForceNavVisible({ scrollable: true, currentY: 400, topOffset: 16 })).toBe(false)
  })
})

const base = { threshold: 10, topOffset: 16, scrollable: true }

describe("nextNavVisible", () => {
  it("is visible near the top regardless of direction", () => {
    const r = nextNavVisible({ ...base, visible: false, anchorY: 100, currentY: 5 })
    expect(r.visible).toBe(true)
  })

  it("is visible when the page is not scrollable", () => {
    const r = nextNavVisible({ ...base, scrollable: false, visible: false, anchorY: 0, currentY: 300 })
    expect(r.visible).toBe(true)
  })

  it("hides after scrolling down past the threshold", () => {
    const r = nextNavVisible({ ...base, visible: true, anchorY: 100, currentY: 120 })
    expect(r.visible).toBe(false)
  })

  it("shows after scrolling up past the threshold", () => {
    const r = nextNavVisible({ ...base, visible: false, anchorY: 300, currentY: 280 })
    expect(r.visible).toBe(true)
  })

  it("ignores jitter below the threshold and keeps the anchor", () => {
    const r = nextNavVisible({ ...base, visible: true, anchorY: 100, currentY: 105 })
    expect(r.visible).toBe(true)
    expect(r.anchorY).toBe(100)
  })

  it("moves the anchor once a decision is made", () => {
    const r = nextNavVisible({ ...base, visible: true, anchorY: 100, currentY: 150 })
    expect(r.anchorY).toBe(150)
  })

  it("accumulates small same-direction steps across calls", () => {
    let s = { visible: true, anchorY: 100 }
    for (const y of [104, 108, 112]) {
      s = nextNavVisible({ ...base, ...s, currentY: y })
    }
    expect(s.visible).toBe(false)
  })

  it("treats rubber-band negative scroll as top", () => {
    const r = nextNavVisible({ ...base, visible: false, anchorY: 50, currentY: -20 })
    expect(r.visible).toBe(true)
  })
})
