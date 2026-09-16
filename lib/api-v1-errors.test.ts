// lib/api-v1-errors.test.ts
import { describe, it, expect } from "vitest"
import { classifyServiceError } from "./api-v1-errors"

describe("classifyServiceError", () => {
  it("returns the error's own message and mapped status for a known code", () => {
    const err = Object.assign(new Error("Insufficient wallet balance"), { code: "INSUFFICIENT_BALANCE" })
    const result = classifyServiceError(err, { INSUFFICIENT_BALANCE: 402, NETWORK_DISABLED: 503 }, "fallback")
    expect(result).toEqual({ status: 402, publicMessage: "Insufficient wallet balance", isKnown: true })
  })

  it("returns the fallback message and 500 for an unrecognized code", () => {
    const err = Object.assign(new Error("relation \"foo\" does not exist"), { code: "42P01" })
    const result = classifyServiceError(err, { INSUFFICIENT_BALANCE: 402 }, "Failed to purchase airtime")
    expect(result).toEqual({ status: 500, publicMessage: "Failed to purchase airtime", isKnown: false })
  })

  it("returns the fallback message and 500 for an error with no code at all", () => {
    const err = new Error("boom")
    const result = classifyServiceError(err, { INSUFFICIENT_BALANCE: 402 }, "fallback")
    expect(result).toEqual({ status: 500, publicMessage: "fallback", isKnown: false })
  })

  it("supports a known code that itself maps to 500 (message still surfaced)", () => {
    const err = Object.assign(new Error("Failed to create order. Wallet refunded."), { code: "ORDER_CREATE_FAILED" })
    const result = classifyServiceError(err, { ORDER_CREATE_FAILED: 500, INSUFFICIENT_BALANCE: 402 }, "fallback")
    expect(result).toEqual({ status: 500, publicMessage: "Failed to create order. Wallet refunded.", isKnown: true })
  })
})
