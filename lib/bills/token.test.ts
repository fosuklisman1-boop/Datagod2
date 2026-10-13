import { describe, expect, it } from "vitest"
import { BILL_TOKEN_TTL_MS, signBillToken, verifyBillToken, type VerifiedBill } from "./token"

const S = "x".repeat(40)
const v: VerifiedBill = { userId: "u1", biller: "dstv", account: "7029864396", phone: null, email: null, broadbandAccount: null, sessionId: null, customerName: "John", verified: true, issuedAt: 1_000_000 }

describe("bill verify token", () => {
  it("round-trips for the same user within 10 minutes", () => {
    expect(verifyBillToken(signBillToken(v, S), S, "u1", 1_000_000 + BILL_TOKEN_TTL_MS)).toEqual(v)
  })
  it("rejects expiry, other user, wrong secret, tampering, garbage", () => {
    const t = signBillToken(v, S)
    expect(verifyBillToken(t, S, "u1", 1_000_000 + BILL_TOKEN_TTL_MS + 1)).toBeNull()
    expect(verifyBillToken(t, S, "u2", 1_000_001)).toBeNull()
    expect(verifyBillToken(t, "y".repeat(40), "u1", 1_000_001)).toBeNull()
    const [body, sig] = t.split(".")
    const forged = Buffer.from(JSON.stringify({ ...v, account: "9999999999" })).toString("base64url") + "." + sig
    expect(verifyBillToken(forged, S, "u1", 1_000_001)).toBeNull()
    expect(verifyBillToken(body, S, "u1", 1_000_001)).toBeNull()
    expect(verifyBillToken("", S, "u1", 1_000_001)).toBeNull()
    expect(verifyBillToken("a.b.c", S, "u1", 1_000_001)).toBeNull()
  })
  it("fails closed on an empty secret", () => {
    expect(() => signBillToken(v, "")).toThrow()
    expect(verifyBillToken(signBillToken(v, S), "", "u1", 1_000_001)).toBeNull()
  })
})
