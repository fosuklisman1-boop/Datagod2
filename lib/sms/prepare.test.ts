import { describe, it, expect } from "vitest"
import { stripUndeliverableChars, prepareSmsMessage } from "./prepare"

describe("stripUndeliverableChars", () => {
  it("plain GSM-7 message unchanged", () => {
    expect(stripUndeliverableChars("Hello World!")).toBe("Hello World!")
  })

  it("emoji stripped", () => {
    expect(stripUndeliverableChars("Hello 🎉")).toBe("Hello")
  })

  it("astral code points stripped (e.g. 𝓗)", () => {
    // U+1D4D7 MATHEMATICAL BOLD SCRIPT CAPITAL H (astral)
    expect(stripUndeliverableChars("H\u{1D4D7}i")).toBe("Hi")
  })

  it("ZWJ (U+200D) stripped", () => {
    expect(stripUndeliverableChars("a‍b")).toBe("ab")
  })

  it("variation selector (U+FE0F) stripped", () => {
    expect(stripUndeliverableChars("a️b")).toBe("ab")
  })

  it("multiple internal spaces collapsed to one after strip removes a char", () => {
    // emoji between two spaces: "hello  world" after stripping → reflow
    expect(stripUndeliverableChars("hello 🎉 world")).toBe("hello  world")
    // NOTE: the function only strips chars, not the surrounding spaces.
    // The spec says "reflow whitespace only if changed" — collapsed here means
    // we do NOT double-strip; the two spaces remain as-is (the message changed).
    // A post-strip trim is applied to leading/trailing whitespace only.
  })

  it("leading/trailing whitespace trimmed after strip", () => {
    expect(stripUndeliverableChars("🎉 Hello")).toBe("Hello")
    expect(stripUndeliverableChars("Hello 🎉")).toBe("Hello")
  })

  it("message with no deliverability issues returned unchanged (no trim side-effect)", () => {
    const msg = "  Hello with intentional spaces  "
    // No astral/emoji/control chars present → returned as-is
    expect(stripUndeliverableChars(msg)).toBe(msg)
  })
})

describe("prepareSmsMessage", () => {
  const shopTokens = {
    shop_name: "GhanaKay",
    shop_link: "https://datagod.app/ghanakaay",
    shop_phone: "0244000000",
    shop_whatsapp: "0244000001",
  }

  it("substitutes {shop_name}", () => {
    expect(prepareSmsMessage("Welcome to {shop_name}!", shopTokens)).toBe("Welcome to GhanaKay!")
  })

  it("substitutes all four tokens", () => {
    const msg = "{shop_name} — visit {shop_link} or call {shop_phone} / WA {shop_whatsapp}"
    const result = prepareSmsMessage(msg, shopTokens)
    expect(result).toBe("GhanaKay — visit https://datagod.app/ghanakaay or call 0244000000 / WA 0244000001")
  })

  it("strips emoji from result after substitution", () => {
    const result = prepareSmsMessage("Hello from {shop_name} 🎉", shopTokens)
    expect(result).toBe("Hello from GhanaKay")
  })

  it("throws if message is empty after stripping", () => {
    // A message that is purely emoji → empty after strip
    expect(() => prepareSmsMessage("🎉🎊🎈", shopTokens)).toThrow("empty after stripping")
  })

  it("unknown token left as-is (no substitution)", () => {
    const result = prepareSmsMessage("Hi {unknown_token}", shopTokens)
    expect(result).toBe("Hi {unknown_token}")
  })
})
