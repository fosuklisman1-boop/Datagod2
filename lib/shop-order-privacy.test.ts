import { describe, expect, it } from "vitest"
import { maskBuyerEmail, maskBuyerName, maskBuyerPhone } from "./shop-order-privacy"

const NOT_TEXT = [null, undefined, "", "   ", 0, 200000123, true, {}, [], ["secret"]]

describe("maskBuyerName", () => {
  it.each([
    ["Testa Buyerson", "Testa"],
    ["  Testa   Middle Buyerson ", "Testa"],
    ["Testa\tBuyerson", "Testa"],
    ["Testa Buyerson", "Testa"],
    ["Testa​Buyerson", "Testa"],
    ["Testa,Buyerson", "Testa"],
    ["Testa.Buyerson", "Testa"],
    ["Testa_Buyerson", "Testa"],
    ["Anne-Marie Buyerson", "Anne-Marie"],
    ["Ɛsi Buyerson", "Ɛsi"],
    ["Guest", "Guest"],
  ])("%j becomes %j", (raw, masked) => expect(maskBuyerName(raw)).toBe(masked))

  // A name box often holds a phone number or an email instead.
  it.each([...NOT_TEXT, "0200000123", "020 000 0123", "Testa0200000123", "buyer@example.test", "---", "..."])(
    "%j becomes null",
    (raw) => expect(maskBuyerName(raw)).toBeNull(),
  )
})

describe("maskBuyerEmail", () => {
  it.each([
    ["buyer@example.test", "b***@example.test"],
    [" buyer@mail.example.test ", "b***@mail.example.test"],
    ["b@example.test", "b***@example.test"],
    ["guest0200000123@example.test", "g***@example.test"],
  ])("%j becomes %j", (raw, masked) => expect(maskBuyerEmail(raw)).toBe(masked))

  it.each([
    ...NOT_TEXT, "buyer", "@example.test", "buyer@", "a@b@example.test", "buyer@0200000123",
    "buyer@localhost", "buyer name@example.test", "buyer@example.test, other@example.test",
  ])("%j becomes null", (raw) => expect(maskBuyerEmail(raw)).toBeNull())
})

describe("maskBuyerPhone", () => {
  it.each([
    ["0200000123", "*******123"],
    ["+233 20 000 0123", "*******123"],
    ["233200000123", "*******123"],
    ["(020) 000-0123", "*******123"],
    ["200000123", "*******123"],
  ])("%j becomes %j", (raw, masked) => expect(maskBuyerPhone(raw)).toBe(masked))

  it.each([...NOT_TEXT, "123", "1234", "12345678", "1234567890123456", "abc", "Testa 0200000123"])(
    "%j becomes null",
    (raw) => expect(maskBuyerPhone(raw)).toBeNull(),
  )
})
