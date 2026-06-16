import { describe, it, expect } from "vitest"
import { filterSmsContent } from "./content-filter"

describe("filterSmsContent — clean messages pass", () => {
  it("plain promotional message passes", () => {
    const r = filterSmsContent("Buy our MTN 5GB bundle for GHS 15 today!")
    expect(r.blocked).toBe(false)
    expect(r.flagged).toBe(false)
    expect(r.reason).toBeUndefined()
  })

  it("allowed domain link passes", () => {
    const r = filterSmsContent("Shop now at https://datagod.app/shop", {
      allowedDomains: ["datagod.app"],
    })
    expect(r.blocked).toBe(false)
    expect(r.flagged).toBe(false)
  })
})

describe("filterSmsContent — phishing / credential patterns block", () => {
  it("'enter your pin' blocks", () => {
    const r = filterSmsContent("Please enter your PIN to verify your account.")
    expect(r.blocked).toBe(true)
    expect(r.reason).toMatch(/pin|credential/i)
  })

  it("'send your password' blocks", () => {
    const r = filterSmsContent("Please send your password to confirm.")
    expect(r.blocked).toBe(true)
  })

  it("prize / lottery blocks", () => {
    const r = filterSmsContent("Congratulations! You have won GHS 5000 in our lottery. Claim now.")
    expect(r.blocked).toBe(true)
    expect(r.reason).toMatch(/prize|lottery|won/i)
  })

  it("fake receipt / account reversal blocks", () => {
    const r = filterSmsContent("Your MoMo account has been reversed. Call immediately to reverse.")
    expect(r.blocked).toBe(true)
  })

  it("'verify your otp' blocks (credential harvest)", () => {
    const r = filterSmsContent("Your OTP is 123456. Never share your OTP with anyone. Send it back to verify.")
    expect(r.blocked).toBe(true)
  })
})

describe("filterSmsContent — suspicious links", () => {
  it("known URL shortener blocks", () => {
    const r = filterSmsContent("Click here: http://bit.ly/abc123")
    expect(r.blocked).toBe(true)
    expect(r.reason).toMatch(/link|url|domain/i)
  })

  it("non-allowed domain flags (not blocked, but flagged)", () => {
    const r = filterSmsContent("Visit http://randomsite.xyz/promo", {
      allowedDomains: ["datagod.app"],
    })
    expect(r.flagged).toBe(true)
    expect(r.blocked).toBe(false)
  })

  it("homoglyph domain blocks (paypa1.com)", () => {
    const r = filterSmsContent("Login at http://paypa1.com/secure")
    expect(r.blocked).toBe(true)
    expect(r.reason).toMatch(/link|domain|homoglyph/i)
  })
})

describe("filterSmsContent — obfuscation evasion still caught", () => {
  it("leet-speak PIN evasion caught: 'p1n' → 'pin'", () => {
    const r = filterSmsContent("Enter your p1n to proceed.")
    expect(r.blocked).toBe(true)
  })

  it("zero-width character injection caught", () => {
    // 'pin' with a zero-width non-joiner (‌) inserted between p and i
    const r = filterSmsContent("Enter your p‌in to proceed.")
    expect(r.blocked).toBe(true)
  })

  it("diacritics evasion caught: 'pîn' → 'pin'", () => {
    const r = filterSmsContent("Enter your pîn now.")
    expect(r.blocked).toBe(true)
  })

  it("Cyrillic homoglyph evasion caught: 'ρin' (rho) → 'pin'", () => {
    // ρ (U+03C1 rho) looks like 'p'
    const r = filterSmsContent("Enter your ρin to verify.")
    expect(r.blocked).toBe(true)
  })

  it("de-spaced evasion caught: 'p.i.n' → 'pin'", () => {
    const r = filterSmsContent("Send your p.i.n to this number.")
    expect(r.blocked).toBe(true)
  })

  it("repeated-char evasion caught: 'piiiiin' → 'pin' after collapsing", () => {
    // De-leet + collapse repeats: 'piiiiin' normalizes to 'pin'
    const r = filterSmsContent("piiiiin needed for verification.")
    expect(r.blocked).toBe(true)
  })

  it("combined evasion: leet + zero-width + de-space all caught", () => {
    // 'p.1‌n' → normalize → 'pin'
    const r = filterSmsContent("p.1‌n required to login.")
    expect(r.blocked).toBe(true)
  })
})

describe("filterSmsContent — custom blocked keywords", () => {
  it("custom blocked keyword blocks", () => {
    const r = filterSmsContent("This is a spam message.", { blockedKeywords: ["spam"] })
    expect(r.blocked).toBe(true)
    expect(r.reason).toMatch(/keyword/i)
  })

  it("custom keyword also subject to normalization", () => {
    const r = filterSmsContent("This is sp‌am.", { blockedKeywords: ["spam"] })
    expect(r.blocked).toBe(true)
  })
})
