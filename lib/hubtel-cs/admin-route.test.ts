import { describe, expect, it } from "vitest"
import { TEST_PURCHASE_MAX_GHS, clampPage, describeError, searchAlternate } from "./admin-route"
import {
  HubtelDisabledError, HubtelDuplicateOrderError, HubtelNotConfiguredError, HubtelOutcomeUnknownError,
  HubtelPausedError, HubtelServiceDisabledError, HubtelValidationError,
} from "./errors"

describe("clampPage", () => {
  it("defaults and clamps limit/offset", () => {
    expect(clampPage(new URLSearchParams())).toEqual({ limit: 25, offset: 0 })
    expect(clampPage(new URLSearchParams("limit=500&offset=-4"))).toEqual({ limit: 100, offset: 0 })
    expect(clampPage(new URLSearchParams("limit=0&offset=10"))).toEqual({ limit: 1, offset: 10 })
    expect(clampPage(new URLSearchParams("limit=abc&offset=xyz"))).toEqual({ limit: 25, offset: 0 })
  })
})

describe("describeError", () => {
  it("maps Hubtel errors to client-safe statuses", () => {
    expect(describeError(new HubtelValidationError("bad"))).toEqual({ status: 400, error: "bad" })
    expect(describeError(new HubtelDisabledError()).status).toBe(409)
    expect(describeError(new HubtelServiceDisabledError("airtime_mtn")).status).toBe(409)
    expect(describeError(new HubtelPausedError("4075")).status).toBe(409)
    expect(describeError(new HubtelNotConfiguredError(["X"])).status).toBe(503)
    expect(describeError(new HubtelDuplicateOrderError("t", "1")).status).toBe(409)
  })
  it("outcome-unknown says do not retry and names the reference, without leaking the cause", () => {
    const d = describeError(new HubtelOutcomeUnknownError("REF123", new Error("secret db password")))
    expect(d.status).toBe(502)
    expect(d.error).toContain("REF123")
    expect(d.error).toMatch(/NOT retry/i)
    expect(d.error).not.toContain("secret")
  })
  it("hides unexpected error details behind a generic 500", () => {
    expect(describeError(new Error("secret db password in message"))).toEqual({ status: 500, error: "Internal error" })
  })
})

describe("searchAlternate", () => {
  it("normalises phone-looking terms to 233 form", () => {
    expect(searchAlternate("0241234567")).toBe("233241234567")
    expect(searchAlternate("+233 24 123 4567")).toBe("233241234567")
  })
  it("returns undefined for non-phone terms", () => {
    expect(searchAlternate("HCS-abc123")).toBeUndefined()
    expect(searchAlternate("")).toBeUndefined()
    expect(searchAlternate(null)).toBeUndefined()
  })
})

it("test purchases are capped at GHS 5", () => {
  expect(TEST_PURCHASE_MAX_GHS).toBe(5)
})
