import { describe, it, expect } from "vitest"
import { resolveForwardLine } from "./forward-secrets"

const P = "primary-secret-for-tests-0123456789"
const M = "main-only-secret-for-tests-9876543210"
const S = "shop-secret-for-tests-5555555555"

describe("resolveForwardLine", () => {
  it("primary and main-only secrets are the main line, the shop secret is the shop line", () => {
    const env = { SMS_FORWARD_SECRET: P, SMS_FORWARD_SECRET_MAIN: M, SMS_FORWARD_SECRET_SHOP: S }
    expect(resolveForwardLine(env, P)).toBe("main")
    expect(resolveForwardLine(env, M)).toBe("main")
    expect(resolveForwardLine(env, S)).toBe("shop")
  })

  it("wrong, empty and missing headers are null", () => {
    const env = { SMS_FORWARD_SECRET: P, SMS_FORWARD_SECRET_SHOP: S }
    expect(resolveForwardLine(env, "nope")).toBeNull()
    expect(resolveForwardLine(env, "")).toBeNull()
    expect(resolveForwardLine(env, null)).toBeNull()
  })

  it("unset or empty secrets never match, even an empty header", () => {
    expect(resolveForwardLine({}, "")).toBeNull()
    expect(resolveForwardLine({ SMS_FORWARD_SECRET: "", SMS_FORWARD_SECRET_SHOP: "" }, "")).toBeNull()
    expect(resolveForwardLine({}, P)).toBeNull()
  })

  it("a shop secret equal to a main secret resolves to main", () => {
    expect(resolveForwardLine({ SMS_FORWARD_SECRET: P, SMS_FORWARD_SECRET_SHOP: P }, P)).toBe("main")
    expect(resolveForwardLine({ SMS_FORWARD_SECRET_MAIN: M, SMS_FORWARD_SECRET_SHOP: M }, M)).toBe("main")
  })
})
