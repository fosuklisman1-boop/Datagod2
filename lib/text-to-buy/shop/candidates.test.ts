import { describe, expect, it } from "vitest"
import { classifyShopCandidates, isShopCodeCandidate, shopCodeCandidates } from "./candidates"

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

  it("treats amount-suffix tokens like 10cedis and 5ghs as amounts", () => {
    expect(shopCodeCandidates("10cedis 5ghs 20cedi")).toEqual([])
  })

  it("classifies strong and weak candidates", () => {
    const c = (t: string, o?: Parameters<typeof classifyShopCandidates>[1]) => classifyShopCandidates(t, o)
    expect(c("kofi123 thanks")).toEqual([{ token: "kofi123", strong: true }, { token: "thanks", strong: false }])
    expect(c("1234 123456 12345 1234567")).toEqual([
      { token: "1234", strong: true }, { token: "123456", strong: true },
      { token: "12345", strong: false }, { token: "1234567", strong: false },
    ])
    expect(c("code kofi")).toEqual([{ token: "kofi", strong: true }])
    expect(c("from Kofi thanks")).toEqual([{ token: "Kofi", strong: true }, { token: "thanks", strong: false }])
    expect(c("shop: Kofi")).toEqual([{ token: "Kofi", strong: true }])
  })

  it("a marker word right after a phone number does not make the next word strong", () => {
    expect(classifyShopCandidates("5gb from 0241234567 thanks")).toEqual([{ token: "thanks", strong: false }])
  })

  it("excludeTokens demotes a 4 or 6 digit token the order read used as a size or amount", () => {
    expect(classifyShopCandidates("1000 kofi123", { excludeTokens: ["1000"] })).toEqual([
      { token: "1000", strong: false }, { token: "kofi123", strong: true },
    ])
  })

  it("expectingCode makes every candidate strong", () => {
    expect(classifyShopCandidates("KOFI", { expectingCode: true })).toEqual([{ token: "KOFI", strong: true }])
    expect(classifyShopCandidates("KOFI")).toEqual([{ token: "KOFI", strong: false }])
  })

  it("isShopCodeCandidate applies the same filter to one token", () => {
    expect(isShopCodeCandidate("kofi123")).toBe(true)
    expect(isShopCodeCandidate("5gb")).toBe(false)
    expect(isShopCodeCandidate("0241234567")).toBe(false)
    expect(isShopCodeCandidate("mtn")).toBe(false)
    expect(isShopCodeCandidate("has space")).toBe(false)
  })
})
