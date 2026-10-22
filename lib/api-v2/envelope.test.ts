import { describe, it, expect } from "vitest"
import { successBody, errorBody, API_VERSION } from "./envelope"

describe("envelope", () => {
  it("builds a success body", () => {
    expect(successBody({ a: 1 }, new Date("2026-10-22T10:00:00Z"))).toEqual({
      success: true,
      data: { a: 1 },
      meta: { timestamp: "2026-10-22T10:00:00.000Z", version: "2" },
    })
    expect(API_VERSION).toBe("2")
  })

  it("builds an error body", () => {
    expect(errorBody(403, "Wrong key type")).toEqual({
      success: false,
      error: { code: 403, message: "Wrong key type" },
    })
  })

  it("never leaks extra fields on errors", () => {
    const body = errorBody(500, "Internal error")
    expect(Object.keys(body).sort()).toEqual(["error", "success"])
    expect(Object.keys(body.error).sort()).toEqual(["code", "message"])
  })
})
