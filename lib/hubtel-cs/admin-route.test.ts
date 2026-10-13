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

import { vi } from "vitest"
import { MAX_NOTE_LEN, MAX_SEARCH_LEN, auditLog, clampSearch, isValidRef, needsEnvGate, parseTestAmount, validateNote } from "./admin-route"

describe("validation helpers", () => {
  it("isValidRef", () => {
    expect(isValidRef("HCS-airtime_mtn-abc123")).toBe(true)
    for (const bad of ["", "a b", "x".repeat(101), "a%b", "a,b", 5, null, undefined, {}]) expect(isValidRef(bad)).toBe(false)
  })
  it("clampSearch caps length", () => {
    expect(clampSearch("x".repeat(500))!.length).toBe(MAX_SEARCH_LEN)
    expect(clampSearch("")).toBeUndefined()
  })
  it("validateNote", () => {
    expect(validateNote("  ok  ")).toEqual({ ok: true, note: "ok" })
    for (const bad of ["", "   ", 5, null, undefined, ["a"], "x".repeat(MAX_NOTE_LEN + 1)]) expect(validateNote(bad).ok).toBe(false)
    expect(validateNote("x".repeat(MAX_NOTE_LEN)).ok).toBe(true)
  })
  it("parseTestAmount accepts numbers and numeric strings only, within the cap", () => {
    expect(parseTestAmount(1.5)).toEqual({ ok: true, amount: 1.5 })
    expect(parseTestAmount("2")).toEqual({ ok: true, amount: 2 })
    for (const bad of [true, [1], { a: 1 }, "", "  ", "abc", 0, -1, 5.01, NaN, Infinity, null, undefined, [] , "[1]"]) expect(parseTestAmount(bad).ok).toBe(false)
  })
  it("needsEnvGate applies when the resulting state is enabled", () => {
    expect(needsEnvGate(true, false)).toBe(true)
    expect(needsEnvGate(undefined, true)).toBe(true) // e.g. mode change while enabled
    expect(needsEnvGate(false, true)).toBe(false)
    expect(needsEnvGate(undefined, false)).toBe(false)
  })
})

describe("auditLog", () => {
  it("skips loudly when there is no admin id", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const insert = vi.fn()
    auditLog({ from: () => ({ insert }) }, { action: "x" })
    expect(insert).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
  it("inserts when an admin id is present", () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    auditLog({ from: () => ({ insert }) }, { adminId: "a1", action: "x" })
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0][0][0].admin_id).toBe("a1")
  })
})
