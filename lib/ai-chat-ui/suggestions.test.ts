import { describe, it, expect } from "vitest"
import { welcomeFor, followupsFor, type ChatContext } from "./suggestions"

const ctxs: ChatContext[] = ["home", "storefront", "dashboard", "admin"]

describe("suggestions", () => {
  it("suggestions_per_context", () => {
    for (const c of ctxs) {
      const w = welcomeFor(c, { sellsData: true, sellsAirtime: true, sellsResultsChecker: true })
      expect(w.subtitle.length).toBeGreaterThan(5)
      expect(w.tryIt.length).toBeGreaterThan(5)
      expect(w.chips.length).toBeGreaterThanOrEqual(3)
      expect(w.chips.length).toBeLessThanOrEqual(4)
      expect(new Set(w.chips).size).toBe(w.chips.length)
    }
    expect(welcomeFor("admin").chips.join(" ")).toMatch(/order|refund|provider|revenue/i)
    expect(welcomeFor("dashboard").chips.join(" ")).toMatch(/order|balance|wallet/i)
  })
  it("storefront respects sold services", () => {
    const only = welcomeFor("storefront", { sellsData: true, sellsAirtime: false, sellsResultsChecker: false })
    const text = [only.tryIt, ...only.chips].join(" ").toLowerCase()
    expect(text).not.toMatch(/airtime|result|checker|waec/)
    expect(text).toMatch(/data|bundle/)
    const air = welcomeFor("storefront", { sellsData: false, sellsAirtime: true, sellsResultsChecker: false })
    expect([air.tryIt, ...air.chips].join(" ").toLowerCase()).not.toMatch(/data|bundle|result|checker/)
    const none = welcomeFor("storefront", { sellsData: false, sellsAirtime: false, sellsResultsChecker: false })
    expect(none.chips.length).toBeGreaterThanOrEqual(1)
    expect([none.tryIt, ...none.chips].join(" ").toLowerCase()).not.toMatch(/airtime|data|bundle|result/)
  })
  it("followups_per_context", () => {
    for (const c of ctxs) {
      const f = followupsFor(c)
      expect(f.length).toBeGreaterThan(0)
      expect(f.length).toBeLessThanOrEqual(3)
    }
  })
})
