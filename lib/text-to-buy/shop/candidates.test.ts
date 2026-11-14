import { describe, expect, it } from "vitest"
import { isShopCodeCandidate, shopCodeCandidates } from "./candidates"

describe("shopCodeCandidates", () => {
  it("takes 4 to 20 character tokens in order of appearance", () => {
    expect(shopCodeCandidates("kofi123 5gb 0241234567")).toEqual(["kofi123"])
    expect(shopCodeCandidates("123456 2gb")).toEqual(["123456"])
    expect(shopCodeCandidates("abc 5gb")).toEqual([])
    expect(shopCodeCandidates("a".repeat(20))).toEqual(["a".repeat(20)])
    expect(shopCodeCandidates("a".repeat(21))).toEqual([])
  })

  it("never offers a Ghana phone number in any written form", () => {
    expect(shopCodeCandidates("0241234567")).toEqual([])
    expect(shopCodeCandidates("+233241234567 5gb")).toEqual([])
    expect(shopCodeCandidates("233241234567")).toEqual([])
    expect(shopCodeCandidates("024 123 4567 shop77")).toEqual(["shop77"])
  })

  it("never offers sizes like 5gb, 500mb, 1.5GB or 5 gb", () => {
    expect(shopCodeCandidates("5gb")).toEqual([])
    expect(shopCodeCandidates("500mb")).toEqual([])
    expect(shopCodeCandidates("1.5GB")).toEqual([])
    expect(shopCodeCandidates("10gigs")).toEqual([])
    expect(shopCodeCandidates("buy 5 gb")).toEqual([])
  })

  it("never offers network words or common order words", () => {
    expect(shopCodeCandidates("MTN vodafone telecel airteltigo ishare bigtime")).toEqual([])
    expect(shopCodeCandidates("please send data airtime to 0241234567")).toEqual([])
    expect(shopCodeCandidates("mtn 5gb for 0241234567 kofi123")).toEqual(["kofi123"])
  })

  it("strips surrounding punctuation, keeps case, dedupes, and keeps order", () => {
    expect(shopCodeCandidates("(Kofi123), 5gb. Zed999! Kofi123")).toEqual(["Kofi123", "Zed999"])
  })

  it("returns nothing for empty or symbol-only text", () => {
    expect(shopCodeCandidates("")).toEqual([])
    expect(shopCodeCandidates("???? !!!!")).toEqual([])
  })

  it("isShopCodeCandidate applies the same filter to one token", () => {
    expect(isShopCodeCandidate("kofi123")).toBe(true)
    expect(isShopCodeCandidate("5gb")).toBe(false)
    expect(isShopCodeCandidate("0241234567")).toBe(false)
    expect(isShopCodeCandidate("mtn")).toBe(false)
    expect(isShopCodeCandidate("has space")).toBe(false)
  })
})
