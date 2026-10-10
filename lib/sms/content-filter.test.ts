import { describe, it, expect } from "vitest"
import { filterSmsContent, matchBlockedContent, suspiciousHostReason, extractLinkHosts } from "./content-filter"

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

describe("matchBlockedContent", () => {
  it("returns the keyword reason for a custom keyword, case/obfuscation-insensitive", () => {
    expect(matchBlockedContent("Win a free L.O.A.N today", ["loan"])).toBe('blocked keyword: "loan"')
  })
  it("returns a built-in phishing reason", () => {
    expect(matchBlockedContent("Send your PIN to confirm", [])).toBe("credential-harvest: pin")
  })
  it("ignores empty keywords", () => {
    expect(matchBlockedContent("Hello there", ["", "  "])).toBeNull()
  })
  it("returns null for clean text", () => {
    expect(matchBlockedContent("Your order is ready", ["loan"])).toBeNull()
  })
})

describe("suspiciousHostReason", () => {
  it("flags shorteners", () => expect(suspiciousHostReason("bit.ly")).toBe("suspicious link: known shortener"))
  it("flags digit-letter lookalikes", () => expect(suspiciousHostReason("paypa1.com")).toBe("suspicious link: homoglyph domain"))
  it("passes normal hosts", () => expect(suspiciousHostReason("datagod.store")).toBeNull())
})

describe("extractLinkHosts", () => {
  it("finds http(s) hosts, lowercased, www stripped", () => {
    expect(extractLinkHosts("Visit https://WWW.Shop.DataGod.store/x now")).toEqual(["shop.datagod.store"])
  })
  it("finds bare and www domains on common TLDs", () => {
    expect(extractLinkHosts("go to www.example.com or kings.shop/abc.")).toEqual(["example.com", "kings.shop"])
  })
  it("finds shorteners without a scheme", () => expect(extractLinkHosts("tap bit.ly/abc")).toEqual(["bit.ly"]))
  it("ignores emails, prices and names", () => {
    expect(extractLinkHosts("mail a@b.com · 5GB for GHS 10.50 · Mr.Smith")).toEqual([])
  })
  it("dedupes and keeps uncommon TLDs when a scheme is present", () => {
    expect(extractLinkHosts("https://evil.ru/x and https://evil.ru/y")).toEqual(["evil.ru"])
  })
})
describe("extractLinkHosts — bypass hardening", () => {
  const cases: Array<[string, string, string[]]> = [
    ["backslash after scheme host", "https://evil.com\\.datagod.store", ["evil.com"]],
    ["trailing bang", "Shop now at https://kings.datagod.store!", ["kings.datagod.store"]],
    ["trailing dot", "Visit https://datagod.store.", ["datagod.store"]],
    ["port", "https://datagod.store:8443/x", ["datagod.store"]],
    ["userinfo", "https://datagod.store@evil.com", ["evil.com"]],
    ["long bare run keeps whole host", "datagod.store.evil.ru/x", ["datagod.store.evil.ru"]],
    ["semicolon", "Visit evil.com; thanks", ["evil.com"]],
    ["ru tld", "Go to evil.ru now", ["evil.ru"]],
    ["uppercase non-word tld", "BUY AT EVIL.COM", ["evil.com"]],
    ["sentence boundary Top", "Hurry now.Top up today", []],
    ["sentence boundary Shop", "Great offer.Shop now", []],
    ["lowercase word tld", "visit kings.shop now", ["kings.shop"]],
    ["lowercase word tld run is a link (pinned trade-off)", "now.top up", ["now.top"]],
  ]
  for (const [name, input, expected] of cases) {
    it(name, () => expect(extractLinkHosts(input)).toEqual(expected))
  }
})

describe("filterSmsContent — scheme host parsing", () => {
  it("does not flag an allowed domain followed by punctuation", () => {
    const r = filterSmsContent("https://datagod.app!", { allowedDomains: ["datagod.app"] })
    expect(r.blocked).toBe(false)
    expect(r.flagged).toBe(false)
  })
})
describe("extractLinkHosts — round-2 hardening", () => {
  const cases: Array<[string, string, string[]]> = [
    ["backslash before @ is not userinfo", "https://evil.com\\@datagod.store", ["evil.com"]],
    ["all-caps word TLD is a link", "BUY AT EVIL.SHOP", ["evil.shop"]],
    ["all-caps hyphenated word TLD is a link", "VERIFY-MOMO.TOP now", ["verify-momo.top"]],
    ["Title-case word TLD, two labels, is prose", "now.Top up", []],
    ["Title-case Shop is prose", "Great offer.Shop now", []],
    ["lowercase word TLD stays a link", "now.top up", ["now.top"]],
    ["Kings.Shop is prose (pinned known cost)", "Kings.Shop", []],
    ["ideographic full stop is normalised", "https://datagod.store。evil。com", ["datagod.store.evil.com"]],
    ["scheme host plus bare host in query", "https://kings.datagod.store/buy?ref=kofi.me", ["kings.datagod.store", "kofi.me"]],
    ["underscore does not hide a host", "Visit_evil.com", ["evil.com"]],
    ["emails stay rejected", "a@b.com", []],
  ]
  for (const [name, input, expected] of cases) {
    it(name, () => {
      const got = extractLinkHosts(input)
      if (name.startsWith("ideographic")) expect(got).toContain(expected[0])
      else expect(got).toEqual(expected)
    })
  }
})