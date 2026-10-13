import { describe, it, expect } from "vitest"
import {
  classifyBuyResponse, shouldRotateIdempotencyKey, validateBundleRecipient, bundleStatusLabel, parsePrefixRules,
  recipientIdentity, keyAfterPhoneEdit, isCatalogStale, findSameBundle, formatGhs, CATALOG_MAX_AGE_MS,
  BUNDLE_CHANGED_MESSAGE, BUNDLE_UNCONFIRMED_MESSAGE, NOT_CHARGED_FAILED_MESSAGE, MAYBE_CHARGED_FAILED_MESSAGE, NOT_YET_PAID_MESSAGE,
  type PrefixRules,
} from "./ui-helpers"
import { DEFAULT_NETWORK_PREFIXES } from "@/lib/phone-format"

const RULES: PrefixRules = { enabled: true, map: DEFAULT_NETWORK_PREFIXES }

describe("parsePrefixRules", () => {
  it("reads map + enabled (missing enabled => on)", () => {
    expect(parsePrefixRules({ map: DEFAULT_NETWORK_PREFIXES })).toEqual({ enabled: true, map: DEFAULT_NETWORK_PREFIXES })
    expect(parsePrefixRules({ enabled: false, map: DEFAULT_NETWORK_PREFIXES })?.enabled).toBe(false)
  })
  it("rejects unusable bodies", () => {
    for (const bad of [null, undefined, {}, { map: null }, { map: { MTN: ["24"] } }, { map: { MTN: [24], TELECEL: [], AT: [] } }, "x"]) {
      expect(parsePrefixRules(bad)).toBeNull()
    }
  })
})

describe("validateBundleRecipient", () => {
  it("accepts a matching number", () => {
    expect(validateBundleRecipient("MTN", "0244123456", RULES)).toBeNull()
    expect(validateBundleRecipient("TELECEL", "0201234567", RULES)).toBeNull()
  })
  it("rejects empty, malformed and wrong-network numbers", () => {
    expect(validateBundleRecipient("MTN", "  ", RULES)).toMatch(/Enter/)
    expect(validateBundleRecipient("MTN", "123", RULES)).toMatch(/valid Ghana/)
    expect(validateBundleRecipient("MTN", "0201234567", RULES)).toMatch(/Telecel/)
  })
  it("I3: uses the admin map (an added prefix is accepted)", () => {
    const rules: PrefixRules = { enabled: true, map: { ...DEFAULT_NETWORK_PREFIXES, MTN: [...DEFAULT_NETWORK_PREFIXES.MTN, "58"] } }
    expect(validateBundleRecipient("MTN", "0581234567", RULES)).not.toBeNull()
    expect(validateBundleRecipient("MTN", "0581234567", rules)).toBeNull()
  })
  it("I3: toggle off or rules unavailable => only the shape is checked (the server decides)", () => {
    expect(validateBundleRecipient("MTN", "0201234567", { ...RULES, enabled: false })).toBeNull()
    expect(validateBundleRecipient("MTN", "0201234567", null)).toBeNull()
    expect(validateBundleRecipient("MTN", "0201234567", undefined)).toBeNull()
    expect(validateBundleRecipient("MTN", "123", null)).toMatch(/valid Ghana/)
  })
})

describe("classifyBuyResponse", () => {
  it("completed and processing are done with the real status", () => {
    expect(classifyBuyResponse(200, { success: true, order: { reference_code: "SB-1", status: "completed", payment_status: "paid" } }))
      .toEqual({ kind: "done", reference: "SB-1", status: "completed" })
    expect(classifyBuyResponse(200, { success: true, order: { reference_code: "SB-2", status: "processing", payment_status: "paid" } }))
      .toMatchObject({ kind: "done", status: "processing" })
  })
  it("a 200 whose paid order failed is a failure with the refund wording", () => {
    expect(classifyBuyResponse(200, { success: true, order: { status: "failed", payment_status: "paid" } }))
      .toEqual({ kind: "failed", message: MAYBE_CHARGED_FAILED_MESSAGE })
  })
  it("I1: a replayed never-charged failed order says 'not charged', never 'refund will follow'", () => {
    expect(classifyBuyResponse(200, { success: true, order: { status: "failed", payment_status: "unpaid" } }))
      .toEqual({ kind: "failed", message: NOT_CHARGED_FAILED_MESSAGE })
    const r402 = classifyBuyResponse(402, { error: "Insufficient wallet balance", order: { status: "failed", payment_status: "unpaid" } })
    expect(r402).toEqual({ kind: "insufficient", message: "Insufficient wallet balance. You were not charged." })
    expect(JSON.stringify(r402)).not.toMatch(/refund/)
    expect(shouldRotateIdempotencyKey(402, { order: { status: "failed", payment_status: "unpaid" } })).toBe(true)
  })
  it("I1: a 200 replay of a pending + unpaid order is not 'done': keep the key, tap Buy to resume", () => {
    const json = { success: true, order: { status: "pending", payment_status: "unpaid" } }
    expect(classifyBuyResponse(200, json)).toEqual({ kind: "retry", message: NOT_YET_PAID_MESSAGE })
    expect(shouldRotateIdempotencyKey(200, json)).toBe(false)
  })
  it("M2: 409 means refresh, with the server's message", () => {
    expect(classifyBuyResponse(409, { error: "Prices refreshed — pick the bundle again" }))
      .toEqual({ kind: "refresh", message: "Prices refreshed — pick the bundle again" })
    expect(classifyBuyResponse(409, {})).toEqual({ kind: "refresh", message: BUNDLE_CHANGED_MESSAGE })
  })
  it("402 means insufficient, not charged", () => {
    expect(classifyBuyResponse(402, { error: "Insufficient wallet balance." })).toEqual({ kind: "insufficient", message: "Insufficient wallet balance. You were not charged." })
    expect(classifyBuyResponse(402, {}).kind).toBe("insufficient")
  })
  it("503/429 are retryable with the server message", () => {
    expect(classifyBuyResponse(503, { error: "busy" })).toEqual({ kind: "retry", message: "busy" })
    expect(classifyBuyResponse(503, { error: "Could not create the order. You were not charged — please try again." }).kind).toBe("retry")
    expect(classifyBuyResponse(429, {}).kind).toBe("retry")
  })
  it.each([0, 500, 502, 504])("status %i without a failed order is unconfirmed, never failed", s => {
    expect(classifyBuyResponse(s, {})).toEqual({ kind: "unconfirmed", message: BUNDLE_UNCONFIRMED_MESSAGE })
    expect(classifyBuyResponse(s, { error: "Payment failed" }).kind).toBe("unconfirmed")
  })
  it("M11: a 500 debit-uncertain answer (order pending/unpaid) stays unconfirmed", () => {
    expect(classifyBuyResponse(500, { error: "We could not confirm your payment.", order: { status: "pending", payment_status: "unpaid" } }).kind).toBe("unconfirmed")
  })
  it("a deliberate error carrying a failed order is a failure with the server message", () => {
    expect(classifyBuyResponse(502, { success: false, error: "Bundle not delivered", order: { status: "failed" } }))
      .toEqual({ kind: "failed", message: "Bundle not delivered" })
  })
  it("M11: known and unknown 4xx show the API message (nothing was charged)", () => {
    expect(classifyBuyResponse(403, { error: "Verify your phone" })).toEqual({ kind: "failed", message: "Verify your phone" })
    expect(classifyBuyResponse(401, { error: "Please sign in again" })).toEqual({ kind: "failed", message: "Please sign in again" })
    expect(classifyBuyResponse(404, {}).kind).toBe("failed")
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

describe("M3: recipientIdentity / keyAfterPhoneEdit", () => {
  const newKey = () => "NEW"
  it("identity is the 233 form for every accepted format", () => {
    for (const p of ["0244123456", "233244123456", "+233 24 412 3456", "244123456"]) expect(recipientIdentity(p)).toBe("233244123456")
    expect(recipientIdentity("024")).toBe("raw:024")
  })
  it("reformatting the same number keeps the key", () => {
    expect(keyAfterPhoneEdit({ prevPhone: "0244123456", nextPhone: "233244123456", currentKey: "K1", lastAttempt: null, newKey })).toBe("K1")
    expect(keyAfterPhoneEdit({ prevPhone: "0244123456", nextPhone: "0244123456 ", currentKey: "K1", lastAttempt: { recipient: "233244123456", key: "K1" }, newKey })).toBe("K1")
  })
  it("a different number gets a new key", () => {
    expect(keyAfterPhoneEdit({ prevPhone: "0244123456", nextPhone: "0244123457", currentKey: "K1", lastAttempt: { recipient: "233244123456", key: "K1" }, newKey })).toBe("NEW")
    // While typing (still incomplete) the digits change, so the key changes too; harmless before any attempt.
    expect(keyAfterPhoneEdit({ prevPhone: "024", nextPhone: "0244", currentKey: "K1", lastAttempt: null, newKey })).toBe("NEW")
  })
  it("going back to the last attempt's number restores that attempt's key", () => {
    expect(keyAfterPhoneEdit({ prevPhone: "0244123457", nextPhone: "+233244123456", currentKey: "K2", lastAttempt: { recipient: "233244123456", key: "K1" }, newKey })).toBe("K1")
  })
})

describe("I2: isCatalogStale / findSameBundle", () => {
  it("stale at 9 minutes, when never loaded, or when the clock went backwards", () => {
    expect(isCatalogStale(null, 0)).toBe(true)
    expect(isCatalogStale(1000, 1000 + CATALOG_MAX_AGE_MS - 1)).toBe(false)
    expect(isCatalogStale(1000, 1000 + CATALOG_MAX_AGE_MS)).toBe(true)
    expect(isCatalogStale(1000, 999)).toBe(true)
    expect(CATALOG_MAX_AGE_MS).toBe(9 * 60_000)
  })
  it("finds the same bundle by exact value, category and 2dp amount", () => {
    const cats = [{ bundles: [{ value: " 5.7 GB ", amount: 20.5, category: "Monthly", token: "t1" }, { value: "x", amount: 5, category: "Data", token: "t2" }] }]
    expect(findSameBundle(cats, { value: " 5.7 GB ", amount: 20.50, category: "Monthly" })?.token).toBe("t1")
    expect(findSameBundle(cats, { value: "5.7 GB", amount: 20.5, category: "Monthly" })).toBeNull()
    expect(findSameBundle(cats, { value: "x", amount: 6, category: "Data" })).toBeNull()
    expect(findSameBundle(cats, { value: "x", amount: 5, category: "Other" })).toBeNull()
  })
})

describe("formatGhs / bundleStatusLabel", () => {
  it("M7: GHS everywhere", () => {
    expect(formatGhs(5)).toBe("GHS 5.00")
    expect(formatGhs(12.3)).toBe("GHS 12.30")
  })
  it("labels", () => {
    expect(bundleStatusLabel("pending", "unpaid").label).toBe("Not charged")
    expect(bundleStatusLabel("failed", "unpaid").label).toBe("Failed - not charged")
    expect(bundleStatusLabel("pending", "paid").label).toBe("Processing")
    expect(bundleStatusLabel("completed", "paid").label).toBe("Completed")
  })
})
