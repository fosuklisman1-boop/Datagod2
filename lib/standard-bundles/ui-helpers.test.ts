import { describe, it, expect } from "vitest"
import {
  classifyBuyResponse, shouldRotateIdempotencyKey, validateBundleRecipient, bundleStatusLabel,
  BUNDLE_CHANGED_MESSAGE, BUNDLE_UNCONFIRMED_MESSAGE,
} from "./ui-helpers"

describe("validateBundleRecipient", () => {
  it("accepts a matching number", () => {
    expect(validateBundleRecipient("MTN", "0244123456")).toBeNull()
    expect(validateBundleRecipient("TELECEL", "0201234567")).toBeNull()
  })
  it("rejects empty, malformed and wrong-network numbers", () => {
    expect(validateBundleRecipient("MTN", "  ")).toMatch(/Enter/)
    expect(validateBundleRecipient("MTN", "123")).toMatch(/valid Ghana/)
    expect(validateBundleRecipient("MTN", "0201234567")).toMatch(/Telecel/)
  })
})

describe("classifyBuyResponse", () => {
  it("completed and processing are done with the real status", () => {
    expect(classifyBuyResponse(200, { success: true, order: { reference_code: "SB-1", status: "completed" } }))
      .toEqual({ kind: "done", reference: "SB-1", status: "completed" })
    expect(classifyBuyResponse(200, { success: true, order: { reference_code: "SB-2", status: "processing" } }))
      .toMatchObject({ kind: "done", status: "processing" })
  })
  it("a 200 whose order failed is a failure", () => {
    expect(classifyBuyResponse(200, { success: true, order: { status: "failed" } }).kind).toBe("failed")
  })
  it("409 means refresh", () => {
    expect(classifyBuyResponse(409, { error: "x" })).toEqual({ kind: "refresh", message: BUNDLE_CHANGED_MESSAGE })
  })
  it("402 means insufficient", () => {
    expect(classifyBuyResponse(402, { error: "Insufficient wallet balance" })).toEqual({ kind: "insufficient", message: "Insufficient wallet balance" })
    expect(classifyBuyResponse(402, {}).kind).toBe("insufficient")
  })
  it("503/429 are retryable", () => {
    expect(classifyBuyResponse(503, { error: "busy" })).toEqual({ kind: "retry", message: "busy" })
    expect(classifyBuyResponse(429, {}).kind).toBe("retry")
  })
  it.each([0, 500, 502, 504])("status %i without an order is unconfirmed, never failed", s => {
    expect(classifyBuyResponse(s, {})).toEqual({ kind: "unconfirmed", message: BUNDLE_UNCONFIRMED_MESSAGE })
    expect(classifyBuyResponse(s, { error: "Payment failed" }).kind).toBe("unconfirmed")
  })
  it("a deliberate error carrying a failed order is a failure with the server message", () => {
    expect(classifyBuyResponse(502, { success: false, error: "Bundle not delivered", order: { status: "failed" } }))
      .toEqual({ kind: "failed", message: "Bundle not delivered" })
  })
  it("known 4xx show the API message", () => {
    expect(classifyBuyResponse(403, { error: "Verify your phone" })).toEqual({ kind: "failed", message: "Verify your phone" })
  })
})

describe("shouldRotateIdempotencyKey", () => {
  it("keeps the key on uncertain outcomes", () => {
    expect(shouldRotateIdempotencyKey(null, {})).toBe(false)
    expect(shouldRotateIdempotencyKey(0, {})).toBe(false)
    expect(shouldRotateIdempotencyKey(500, {})).toBe(false)
    expect(shouldRotateIdempotencyKey(502, { error: "x" })).toBe(false)
    expect(shouldRotateIdempotencyKey(504, {})).toBe(false)
    expect(shouldRotateIdempotencyKey(200, {})).toBe(false)
    expect(shouldRotateIdempotencyKey(200, { order: { status: "processing" } })).toBe(false)
    expect(shouldRotateIdempotencyKey(200, { order: { status: "pending" } })).toBe(false)
    expect(shouldRotateIdempotencyKey(200, { order: { status: "completed" } })).toBe(false)
    expect(shouldRotateIdempotencyKey(429, {})).toBe(false)
    expect(shouldRotateIdempotencyKey(503, {})).toBe(false)
  })
  it("rotates after definite non-delivery", () => {
    expect(shouldRotateIdempotencyKey(402, {})).toBe(true)
    expect(shouldRotateIdempotencyKey(409, {})).toBe(true)
    expect(shouldRotateIdempotencyKey(400, {})).toBe(true)
    expect(shouldRotateIdempotencyKey(403, {})).toBe(true)
    expect(shouldRotateIdempotencyKey(200, { order: { status: "failed" } })).toBe(true)
    expect(shouldRotateIdempotencyKey(502, { order: { status: "failed" } })).toBe(true)
  })
})

describe("bundleStatusLabel", () => {
  it("labels", () => {
    expect(bundleStatusLabel("pending", "unpaid").label).toBe("Not charged")
    expect(bundleStatusLabel("failed", "unpaid").label).toBe("Failed - not charged")
    expect(bundleStatusLabel("pending", "paid").label).toBe("Processing")
    expect(bundleStatusLabel("completed", "paid").label).toBe("Completed")
  })
})
