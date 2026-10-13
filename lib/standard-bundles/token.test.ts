import { describe, it, expect } from "vitest"
import { signBundleToken, verifyBundleToken, BUNDLE_TOKEN_TTL_MS, type VerifiedBundle } from "./token"
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
})
