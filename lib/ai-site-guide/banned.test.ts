import { describe, expect, it } from "vitest"
import { PROVIDER_DISPLAY } from "../mtn-providers/provider-display"
import { BANNED_FOR_NON_ADMIN, bannedHits } from "./banned"

describe("BANNED_FOR_NON_ADMIN", () => {
  it("is lowercase, trimmed and unique", () => {
    for (const w of BANNED_FOR_NON_ADMIN) {
      expect(w).toBe(w.toLowerCase().trim())
      expect(w.length).toBeGreaterThan(0)
    }
    expect(new Set(BANNED_FOR_NON_ADMIN).size).toBe(BANNED_FOR_NON_ADMIN.length)
  })

  it("carries the fixed risk words from the brief", () => {
    for (const w of ["fraud", "threshold", "blacklist", "velocity", "risk score"]) {
      expect(BANNED_FOR_NON_ADMIN).toContain(w)
    }
  })

  it("covers every supplier shown in the provider display map (drift guard)", () => {
    for (const [key, { label }] of Object.entries(PROVIDER_DISPLAY)) {
      expect(bannedHits(key), `key ${key}`).not.toEqual([])
      expect(bannedHits(label), `label ${label}`).not.toEqual([])
    }
  })

  it("covers supplier names that exist only in provider code", () => {
    for (const name of ["Digiwapy", "SPFastIT", "Data Kazina", "Agent Portal GH", "Code Craft", "Bundle Portal"]) {
      expect(bannedHits(name), name).not.toEqual([])
    }
  })
})

describe("bannedHits", () => {
  it("matches case-insensitively and returns lowercase terms", () => {
    expect(bannedHits("We use SYKES for this")).toEqual(["sykes"])
  })

  it("matches whole words only", () => {
    expect(bannedHits("Express delivery and hubnetwork talk")).toEqual([])
    expect(bannedHits("An xpress order")).toEqual(["xpress"])
  })

  it("matches multi-word terms across spacing and case", () => {
    expect(bannedHits("The RISK   Score is high")).toEqual(["risk score"])
    expect(bannedHits("sent via apex prime today")).toContain("apex prime")
  })

  it("returns each term once, in list order", () => {
    const hits = bannedHits("fraud, FRAUD and a threshold; also fraud")
    expect(hits).toEqual(["fraud", "threshold"])
  })

  it("returns [] for clean customer text", () => {
    expect(bannedHits("Open Data packages, pick MTN, pay from your wallet.")).toEqual([])
  })

  it("matches next to punctuation", () => {
    expect(bannedHits("(Kuntanii).")).toEqual(["kuntanii"])
  })
})
