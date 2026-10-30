import { describe, it, expect } from "vitest"
import {
  signBundleToken, verifyBundleToken, signSpecialToken, verifySpecialToken, isSpecialTokenSigned, BUNDLE_TOKEN_TTL_MS, type VerifiedBundle,
} from "./token"
import { signBillToken } from "@/lib/bills/token"

const S = "secret-1"
const T0 = 1_800_000_000_000
const v: VerifiedBundle = { network: "MTN", value: "db_Data_1GB ", amount: 5, display: "1GB", category: "Data", issuedAt: T0 }

describe("bundle token", () => {
  it("round-trips", () => {
    expect(verifyBundleToken(signBundleToken(v, S), S, T0 + 1000)).toEqual(v)
  })
  it("rejects tampered body", () => {
    const [b, s] = signBundleToken(v, S).split(".")
    const forged = Buffer.from(JSON.stringify({ ...v, amount: 1 })).toString("base64url")
    expect(verifyBundleToken(`${forged}.${s}`, S, T0)).toBeNull()
    expect(verifyBundleToken(`${b}.${s}x`, S, T0)).toBeNull()
  })
  it("rejects expired and future-dated", () => {
    const t = signBundleToken(v, S)
    expect(verifyBundleToken(t, S, T0 + BUNDLE_TOKEN_TTL_MS + 1)).toBeNull()
    expect(verifyBundleToken(t, S, T0 + BUNDLE_TOKEN_TTL_MS)).not.toBeNull()
    expect(verifyBundleToken(t, S, T0 - 61_000)).toBeNull()
  })
  it("rejects wrong secret", () => {
    expect(verifyBundleToken(signBundleToken(v, S), "other", T0)).toBeNull()
  })
  it("fails closed on empty secret", () => {
    expect(() => signBundleToken(v, "")).toThrow()
    expect(verifyBundleToken(signBundleToken(v, S), "", T0)).toBeNull()
  })
  it("rejects garbage", () => {
    expect(verifyBundleToken("abc", S, T0)).toBeNull()
    expect(verifyBundleToken(undefined as any, S, T0)).toBeNull()
  })
  it("never verifies a bills token", () => {
    const bill = signBillToken({
      userId: "u", biller: "ecg", account: "1", phone: null, email: null, broadbandAccount: null,
      sessionId: null, customerName: null, verified: true, issuedAt: T0,
    }, S)
    expect(verifyBundleToken(bill, S, T0)).toBeNull()
  })
  it("a bundle token with a valid bills-style MAC of the same body is rejected (domain separation)", () => {
    const { createHmac } = require("crypto")
    const body = Buffer.from(JSON.stringify(v)).toString("base64url")
    const sig = createHmac("sha256", S).update("bills-verify:" + body).digest("hex")
    expect(verifyBundleToken(`${body}.${sig}`, S, T0)).toBeNull()
  })
  it("normal token bytes are pinned (storefront/bot/API tokens stay byte-identical)", () => {
    expect(signBundleToken(v, S)).toBe(
      "eyJuZXR3b3JrIjoiTVROIiwidmFsdWUiOiJkYl9EYXRhXzFHQiAiLCJhbW91bnQiOjUsImRpc3BsYXkiOiIxR0IiLCJjYXRlZ29yeSI6IkRhdGEiLCJpc3N1ZWRBdCI6MTgwMDAwMDAwMDAwMH0" +
      ".a2670a6d231e82c3e39dfafed3c0f64268fcb40e63eea24afdcc41500e8666d8",
    )
  })
})

describe("special token", () => {
  const unit: VerifiedBundle = { network: "MTN", value: "RACT_Data_GHC_3_Others", amount: 3, display: "406.89MB", category: "Data", issuedAt: T0 }
  const special = () => signSpecialToken({ unitToken: signBundleToken(unit, S), n: 5, issuedAt: T0 }, S)

  it("round-trips, returning the verified unit and n", () => {
    expect(verifySpecialToken(special(), S, T0 + 1000)).toEqual({ unit, n: 5, issuedAt: T0 })
  })
  it("expires on the same 10-minute TTL", () => {
    const t = special()
    expect(verifySpecialToken(t, S, T0 + BUNDLE_TOKEN_TTL_MS)).not.toBeNull()
    expect(verifySpecialToken(t, S, T0 + BUNDLE_TOKEN_TTL_MS + 1)).toBeNull()
    expect(verifySpecialToken(t, S, T0 - 61_000)).toBeNull()
  })
  it("a special token never verifies as a normal bundle token", () => {
    expect(verifyBundleToken(special(), S, T0)).toBeNull()
  })
  it("a normal bundle token never verifies as a special token", () => {
    expect(verifySpecialToken(signBundleToken(unit, S), S, T0)).toBeNull()
  })
  it("a special body MAC'd under the normal domain is refused (type tag is in the MAC domain)", () => {
    const { createHmac } = require("crypto")
    const body = special().split(".")[0]
    const sig = createHmac("sha256", S).update("bundles-catalog:" + body).digest("hex")
    expect(verifySpecialToken(`${body}.${sig}`, S, T0)).toBeNull()
  })
  it("a correctly MAC'd special body without the type tag is refused", () => {
    const { createHmac } = require("crypto")
    const body = Buffer.from(JSON.stringify({ unitToken: signBundleToken(unit, S), n: 5, issuedAt: T0 })).toString("base64url")
    const sig = createHmac("sha256", S).update("bundles-special:" + body).digest("hex")
    expect(verifySpecialToken(`${body}.${sig}`, S, T0)).toBeNull()
  })
  it("rejects wrong secret, tampering, empty secret and garbage", () => {
    const t = special()
    expect(verifySpecialToken(t, "other", T0)).toBeNull()
    const [, sig] = t.split(".")
    const forged = Buffer.from(JSON.stringify({ type: "special", unitToken: signBundleToken(unit, S), n: 50, issuedAt: T0 })).toString("base64url")
    expect(verifySpecialToken(`${forged}.${sig}`, S, T0)).toBeNull()
    expect(verifySpecialToken(t, "", T0)).toBeNull()
    expect(() => signSpecialToken({ unitToken: "x", n: 3, issuedAt: T0 }, "")).toThrow()
    expect(verifySpecialToken("abc", S, T0)).toBeNull()
    expect(verifySpecialToken(undefined as any, S, T0)).toBeNull()
  })
  it("rejects n outside 1..50 or non-integer", () => {
    const ut = signBundleToken(unit, S)
    for (const n of [0, 51, 2.5, -1, NaN]) {
      expect(verifySpecialToken(signSpecialToken({ unitToken: ut, n, issuedAt: T0 }, S), S, T0)).toBeNull()
    }
    expect(verifySpecialToken(signSpecialToken({ unitToken: ut, n: 50, issuedAt: T0 }, S), S, T0)).not.toBeNull()
  })
  it("rejects an invalid, foreign-secret or non-MTN unit token", () => {
    expect(verifySpecialToken(signSpecialToken({ unitToken: "junk", n: 3, issuedAt: T0 }, S), S, T0)).toBeNull()
    expect(verifySpecialToken(signSpecialToken({ unitToken: signBundleToken(unit, "other"), n: 3, issuedAt: T0 }, S), S, T0)).toBeNull()
    const at = signBundleToken({ ...unit, network: "AT" }, S)
    expect(verifySpecialToken(signSpecialToken({ unitToken: at, n: 3, issuedAt: T0 }, S), S, T0)).toBeNull()
  })
  it("rejects a unit token issued at a different time than the special token", () => {
    const ut = signBundleToken({ ...unit, issuedAt: T0 - 1000 }, S)
    expect(verifySpecialToken(signSpecialToken({ unitToken: ut, n: 3, issuedAt: T0 }, S), S, T0)).toBeNull()
  })
})

describe("isSpecialTokenSigned (route branch: MAC + type only, no freshness)", () => {
  const unit: VerifiedBundle = { network: "MTN", value: "RACT_Data_GHC_3_Others", amount: 3, display: "406.89MB", category: "Data", issuedAt: T0 }
  const special = () => signSpecialToken({ unitToken: signBundleToken(unit, S), n: 3, issuedAt: T0 }, S)
  it("true for a special token, even an expired one", () => {
    expect(isSpecialTokenSigned(special(), S)).toBe(true)
  })
  it("false for a normal bundle token, a foreign secret, tampering, empty secret and garbage", () => {
    expect(isSpecialTokenSigned(signBundleToken(unit, S), S)).toBe(false)
    expect(isSpecialTokenSigned(special(), "other")).toBe(false)
    const [, sig] = special().split(".")
    const forged = Buffer.from(JSON.stringify({ type: "special", unitToken: "x", n: 50, issuedAt: T0 })).toString("base64url")
    expect(isSpecialTokenSigned(`${forged}.${sig}`, S)).toBe(false)
    expect(isSpecialTokenSigned(special(), "")).toBe(false)
    expect(isSpecialTokenSigned("abc", S)).toBe(false)
    expect(isSpecialTokenSigned(undefined as any, S)).toBe(false)
  })
})
