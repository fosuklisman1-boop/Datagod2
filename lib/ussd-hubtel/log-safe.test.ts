// lib/ussd-hubtel/log-safe.test.ts
import { describe, it, expect } from "vitest"
import { safeDbError, SAFE_DB_ERROR_MAX } from "./log-safe"

describe("safeDbError", () => {
  it("keeps the code and message, drops details and hint", () => {
    const out = safeDbError({
      code: "23502",
      message: 'null value in column "location" of relation "ussd_afa_orders" violates not-null constraint',
      details: "Failing row contains (a1, Kwame Mensah, GHA-123456789-0, 0244123456, null).",
      hint: "row hint",
    })
    expect(out).toEqual({
      code: "23502",
      message: 'null value in column "location" of relation "ussd_afa_orders" violates not-null constraint',
    })
    expect(JSON.stringify(out)).not.toMatch(/Kwame|GHA-|0244123456|hint/)
  })

  it("strips row details that leaked into the message itself", () => {
    const out = safeDbError({ code: "23514", message: "new row violates check constraint. Failing row contains (x, 1234567890, 01/02/2005, PIN-9)" })
    expect(out.code).toBe("23514")
    expect(out.message).not.toMatch(/1234567890|PIN-9|01\/02\/2005/)
    expect(out.message).toMatch(/violates check constraint/)
  })

  it("strips unique-violation key values", () => {
    const out = safeDbError({ code: "23505", message: "duplicate key value violates unique constraint \"x\" Key (session_id)=(S-secret) already exists." })
    expect(out.message).not.toContain("S-secret")
    expect(out.message).toMatch(/duplicate key value/)
  })

  it("truncates long messages", () => {
    const out = safeDbError({ message: "a".repeat(1000) })
    expect(out.message.length).toBeLessThanOrEqual(SAFE_DB_ERROR_MAX + 3)
  })

  it("handles Error instances, strings and nullish values", () => {
    expect(safeDbError(new Error("boom"))).toEqual({ message: "boom" })
    expect(safeDbError("plain")).toEqual({ message: "plain" })
    expect(safeDbError(null)).toEqual({ message: "unknown error" })
    expect(safeDbError({})).toEqual({ message: "unknown error" })
  })

  it("never includes non-string codes", () => {
    expect(safeDbError({ code: 42, message: "x" })).toEqual({ message: "x" })
  })
})
