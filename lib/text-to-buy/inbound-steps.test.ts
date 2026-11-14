import { describe, expect, it } from "vitest"
import { pickedAmount } from "./inbound-steps"
import type { Pending } from "./store"

const ask: Pending = { type: "amount", network: null }
const air = (amountGhs: number, networkHint: "MTN" | null = null) => ({ kind: "order", service: "airtime", amountGhs, networkHint, recipient: null })

describe("pickedAmount (the answer to 'How much airtime do you want?')", () => {
  it.each([["10", 10], [" 10 ", 10], ["10.", 10], ["12.5", 12.5], ["12.50", 12.5], ["150", 150], ["0.5", 0.5]])("a bare number %j is the airtime amount", (t, n) => {
    expect(pickedAmount(t, ask)).toEqual(air(n))
  })

  it("carries the network the customer named when the question was asked", () => {
    expect(pickedAmount("10", { type: "amount", network: "MTN" })).toEqual(air(10, "MTN"))
  })

  it.each(["5gb", "10 cedis", "ghs 10", "airtime 10", "1,000", "10.555", "0", "0.00", "007", "-5", "1e3", "1234567", "yes", "", "10 20", "0200000102"])(
    "anything but a bare number is not the answer: %j", (t) => {
      expect(pickedAmount(t, ask)).toBeNull()
    })

  it("applies only while the amount question is pending", () => {
    expect(pickedAmount("10", null)).toBeNull()
    expect(pickedAmount("10", { type: "quantity", board: "WASSCE" })).toBeNull()
    expect(pickedAmount("10", { type: "choices", options: [] })).toBeNull()
    expect(pickedAmount("10", { type: "confirm", read: { kind: "not_order" } })).toBeNull()
  })
})
