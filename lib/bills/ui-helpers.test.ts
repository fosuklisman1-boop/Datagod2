import { describe, it, expect } from "vitest"
import { classifyPayResponse, billStatusLabel, UNCONFIRMED_PAYMENT_MESSAGE } from "./ui-helpers"

describe("classifyPayResponse", () => {
  it("success", () => {
    expect(classifyPayResponse(200, { success: true, order: { reference_code: "B1", status: "completed" } })).toEqual({ kind: "done", reference: "B1", status: "completed" })
  })
  it("503/429 keep the token", () => {
    expect(classifyPayResponse(503, { error: "x" })).toEqual({ kind: "retry", message: "x" })
    expect(classifyPayResponse(429, {}).kind).toBe("retry")
  })
  it("known failures show the API message", () => {
    expect(classifyPayResponse(402, { error: "Insufficient wallet balance" })).toEqual({ kind: "back", message: "Insufficient wallet balance" })
    expect(classifyPayResponse(400, {})).toMatchObject({ kind: "back", message: expect.stringContaining("Payment failed") })
    expect((classifyPayResponse(409, { error: "again" }) as { message: string }).message).toBe("again")
  })
  it.each([0, 500, 502, 504, 418, 401, 200])("unconfirmed for status %i with a non-JSON ({}) body", s => {
    expect(classifyPayResponse(s, {})).toEqual({ kind: "back", message: UNCONFIRMED_PAYMENT_MESSAGE })
  })
  it("a 504 with an error body is still unconfirmed, never 'Payment failed'", () => {
    expect((classifyPayResponse(504, { error: "Payment failed" }) as { message: string }).message).toBe(UNCONFIRMED_PAYMENT_MESSAGE)
  })
})

describe("billStatusLabel", () => {
  it("phantom unpaid orders", () => {
    expect(billStatusLabel("pending", "unpaid").label).toBe("Not charged")
    expect(billStatusLabel("failed", "unpaid").label).toBe("Failed — not charged")
  })
  it("paid orders keep their status", () => {
    expect(billStatusLabel("pending", "paid").label).toBe("pending")
    expect(billStatusLabel("failed", "paid").label).toBe("failed")
    expect(billStatusLabel("refunded", "refunded").label).toBe("refunded")
  })
})
