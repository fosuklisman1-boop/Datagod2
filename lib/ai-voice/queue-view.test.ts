import { describe, expect, it } from "vitest"
import { ordinal, queueEtaLabel, queueHeading, queueProgress } from "./queue-view"

describe("ordinal", () => {
  it.each([[1, "1st"], [2, "2nd"], [3, "3rd"], [4, "4th"], [11, "11th"], [12, "12th"], [13, "13th"], [21, "21st"], [22, "22nd"], [103, "103rd"]])(
    "%i -> %s", (n, s) => expect(ordinal(n)).toBe(s),
  )
})

describe("queueHeading", () => {
  it("names the place, and says 'next' at the front", () => {
    expect(queueHeading(3, 360)).toBe("You're 3rd in line · About 6 min")
    expect(queueHeading(1, 180)).toBe("You're 1st in line · About 3 min")
  })
})

describe("queueEtaLabel", () => {
  it("rounds up to whole minutes, at least 1", () => {
    expect(queueEtaLabel(0)).toBe("About 1 min")
    expect(queueEtaLabel(61)).toBe("About 2 min")
    expect(queueEtaLabel(180)).toBe("About 3 min")
  })
})

describe("queueProgress", () => {
  it("grows as the place improves and stays between 5 and 95", () => {
    expect(queueProgress(5, 5)).toBeLessThan(queueProgress(5, 1))
    expect(queueProgress(1, 1)).toBe(50)
    expect(queueProgress(5, 1)).toBeLessThanOrEqual(95)
    expect(queueProgress(100, 100)).toBeGreaterThanOrEqual(5)
  })
  it("never goes backwards when the line grows past where the caller started", () => {
    expect(queueProgress(2, 4)).toBeGreaterThanOrEqual(5)
  })
})
