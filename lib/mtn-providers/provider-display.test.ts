import { describe, it, expect } from "vitest"
import { PROVIDER_DISPLAY, getProviderDisplay } from "./provider-display"

describe("PROVIDER_DISPLAY", () => {
  it("has an entry for every provider name known to the factory", () => {
    // Mirrors lib/mtn-providers/factory.ts's VALID_PROVIDERS plus the
    // non-MTN-only providers (spfastit) — every string that can ever land in
    // mtn_fulfillment_tracking.provider must resolve to a real label here.
    const allProviders = [
      "sykes", "datakazina", "xpress", "eazyghdata", "bisdel", "codecraft",
      "agentportalgh", "apexprime", "spfastit", "bundleportal",
    ]
    for (const p of allProviders) {
      expect(PROVIDER_DISPLAY[p], `missing PROVIDER_DISPLAY entry for "${p}"`).toBeDefined()
      expect(PROVIDER_DISPLAY[p].label.length).toBeGreaterThan(0)
    }
  })
})

describe("getProviderDisplay", () => {
  it("returns the real label for a known provider", () => {
    expect(getProviderDisplay("sykes").label).toBe("Sykes")
    expect(getProviderDisplay("spfastit").label).toBe("SPFastIT")
    expect(getProviderDisplay("bundleportal").label).toBe("Bundle Portal")
  })

  it("never silently mislabels an unrecognized provider as a different real provider", () => {
    // The exact bug this module fixes: a hardcoded if/else chain's catch-all
    // branch rendered "Sykes" for ANY unmatched provider string, including
    // genuinely new ones (spfastit, bundleportal) that were simply never
    // added to the chain. This must show the raw value back, never "Sykes"
    // (or any other specific provider's label) for a name it doesn't recognize.
    const result = getProviderDisplay("some_future_provider_not_yet_added")
    expect(result.label).not.toBe("Sykes")
    expect(result.label).toBe("some_future_provider_not_yet_added")
  })

  it("labels a missing/null provider as Unknown, not Sykes", () => {
    expect(getProviderDisplay(null).label).toBe("Unknown")
    expect(getProviderDisplay(undefined).label).toBe("Unknown")
    expect(getProviderDisplay("").label).toBe("Unknown")
  })

  it("always returns a non-empty badgeClassName", () => {
    expect(getProviderDisplay("apexprime").badgeClassName.length).toBeGreaterThan(0)
    expect(getProviderDisplay("totally_unknown").badgeClassName.length).toBeGreaterThan(0)
    expect(getProviderDisplay(null).badgeClassName.length).toBeGreaterThan(0)
  })
})
