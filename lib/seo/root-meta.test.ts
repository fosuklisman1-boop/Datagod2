import { describe, it, expect } from "vitest"
import { HTML_LANG, ROOT_DESCRIPTION, ROOT_LOCALE, ROOT_TITLE, siteVerification } from "./root-meta"

const BANNED = /instant|in seconds|automatic(ally)? refund/i

describe("root metadata copy", () => {
  it("keeps the title <= 60 chars ending in | DATAGOD, naming all three networks", () => {
    expect(ROOT_TITLE.length).toBeLessThanOrEqual(60)
    expect(ROOT_TITLE.endsWith("| DATAGOD")).toBe(true)
    for (const n of ["MTN", "Telecel", "AT", "Ghana"]) expect(ROOT_TITLE).toContain(n)
  })

  it("keeps the description 120-160 chars, mentioning MoMo, the networks and Ghana", () => {
    expect(ROOT_DESCRIPTION.length).toBeGreaterThanOrEqual(120)
    expect(ROOT_DESCRIPTION.length).toBeLessThanOrEqual(160)
    for (const n of ["MoMo", "MTN", "Telecel", "AT", "Ghana", "wallet"]) expect(ROOT_DESCRIPTION).toContain(n)
    expect(ROOT_DESCRIPTION).toContain("Usually delivered within minutes.")
  })

  it("never uses banned wording", () => {
    expect(`${ROOT_TITLE}\n${ROOT_DESCRIPTION}`).not.toMatch(BANNED)
  })

  it("targets Ghanaian English", () => {
    expect(ROOT_LOCALE).toBe("en_GH")
    expect(HTML_LANG).toBe("en-GH")
  })
})

describe("siteVerification", () => {
  it("is undefined when neither variable is set or both are blank", () => {
    expect(siteVerification({})).toBeUndefined()
    expect(siteVerification({ GOOGLE_SITE_VERIFICATION: " ", BING_SITE_VERIFICATION: "" })).toBeUndefined()
  })
  it("includes only the tags that are set", () => {
    expect(siteVerification({ GOOGLE_SITE_VERIFICATION: "g-123" })).toEqual({ google: "g-123" })
    expect(siteVerification({ BING_SITE_VERIFICATION: "b-456" })).toEqual({ other: { "msvalidate.01": "b-456" } })
    expect(siteVerification({ GOOGLE_SITE_VERIFICATION: " g ", BING_SITE_VERIFICATION: "b" })).toEqual({
      google: "g",
      other: { "msvalidate.01": "b" },
    })
  })
})
