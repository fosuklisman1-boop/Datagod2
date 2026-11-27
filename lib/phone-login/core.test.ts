import { describe, it, expect, afterEach } from "vitest"
import { createHmac } from "node:crypto"
import {
  hashSecretConfigured,
  GENERIC_LOGIN_ERROR,
  PHONE_LOGIN_PURPOSE,
  LIMITS,
  phoneKey,
  sha256Hex,
  phoneHash,
  ipHash,
  newToken,
  maskPhone,
  isEligible,
  uaLabel,
  type Account,
} from "./core"

const base: Account = {
  matchCount: 1,
  verifiedCount: 1,
  userId: "user-1",
  email: "a@example.com",
  phone: "0241234567",
  phoneVerified: true,
  isSuspended: false,
}

describe("constants", () => {
  it("exposes the generic error and purpose", () => {
    expect(GENERIC_LOGIN_ERROR).toBe("Phone number or password is incorrect.")
    expect(PHONE_LOGIN_PURPOSE).toBe("phone_login")
  })

  it("exposes the brief's limits verbatim", () => {
    expect(LIMITS).toEqual({
      ipStep1: { max: 10, windowMs: 900_000 },
      ipVerify: { max: 10, windowMs: 900_000 },
      challengeTtlMs: 600_000,
      maxCodeAttempts: 5,
      resendGapMs: 60_000,
      deviceTtlMs: 2_592_000_000,
      maxDevices: 10,
    })
  })
})

describe("phoneKey", () => {
  it.each(["0241234567", "+233241234567", "233241234567", "241234567"])(
    "normalises %s to the same sig and canonical form",
    (input) => {
      expect(phoneKey(input)).toEqual({ sig: "241234567", canonical: "0241234567" })
    },
  )

  it.each(["", "abc", "0141234567"])("returns null for %j", (input) => {
    expect(phoneKey(input)).toBeNull()
  })
})

describe("maskPhone", () => {
  it("keeps the first three and last two digits", () => {
    expect(maskPhone("0241234567")).toBe("024 *** **67")
  })
})

describe("newToken", () => {
  it("is 43 base64url characters and differs between calls", () => {
    const a = newToken()
    const b = newToken()
    expect(a).toHaveLength(43)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })
})

describe("hashing", () => {
  it("sha256Hex is a stable 64-char hex digest", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"))
    expect(sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/)
  })

  const SECRET = "test-secret-test-secret-test-secret-1234"
  const saved = process.env.PHONE_LOGIN_HASH_SECRET
  afterEach(() => {
    if (saved === undefined) delete process.env.PHONE_LOGIN_HASH_SECRET
    else process.env.PHONE_LOGIN_HASH_SECRET = saved
  })

  it("phoneHash/ipHash are HMAC-SHA256 with the server secret, domain-prefixed, and differ from each other", () => {
    process.env.PHONE_LOGIN_HASH_SECRET = SECRET
    const hmac = (s: string) => createHmac("sha256", SECRET).update(s, "utf8").digest("hex")
    expect(phoneHash("241234567")).toBe(phoneHash("241234567"))
    expect(phoneHash("241234567")).toBe(hmac("phone-login:241234567"))
    expect(phoneHash("241234567")).not.toBe(sha256Hex("phone-login:241234567"))
    expect(phoneHash("x")).not.toBe(ipHash("x"))
    expect(ipHash("x")).toBe(hmac("phone-login-ip:x"))
  })

  it("a different secret gives different hashes", () => {
    process.env.PHONE_LOGIN_HASH_SECRET = SECRET
    const a = phoneHash("241234567")
    process.env.PHONE_LOGIN_HASH_SECRET = SECRET + "other"
    expect(phoneHash("241234567")).not.toBe(a)
  })

  it("fails closed: a missing or short secret throws and is reported unconfigured (never an unkeyed hash)", () => {
    delete process.env.PHONE_LOGIN_HASH_SECRET
    expect(hashSecretConfigured()).toBe(false)
    expect(() => phoneHash("241234567")).toThrow()
    expect(() => ipHash("1.2.3.4")).toThrow()
    process.env.PHONE_LOGIN_HASH_SECRET = "x".repeat(31)
    expect(hashSecretConfigured()).toBe(false)
    expect(() => phoneHash("241234567")).toThrow()
    process.env.PHONE_LOGIN_HASH_SECRET = "x".repeat(32)
    expect(hashSecretConfigured()).toBe(true)
    expect(() => phoneHash("241234567")).not.toThrow()
  })
})

describe("isEligible", () => {
  it("is true for a single verified, active, complete account", () => {
    expect(isEligible(base)).toBe(true)
  })

  it("is true when a verified account shares the number with one unverified squatter", () => {
    expect(isEligible({ ...base, matchCount: 2, verifiedCount: 1 })).toBe(true)
  })

  it("is false when two accounts are verified on the number", () => {
    expect(isEligible({ ...base, matchCount: 2, verifiedCount: 2 })).toBe(false)
  })

  it("is false when no account is verified", () => {
    expect(isEligible({ ...base, verifiedCount: 0 })).toBe(false)
  })

  it("is false when the phone is not verified", () => {
    expect(isEligible({ ...base, phoneVerified: false })).toBe(false)
  })

  it("is false when the account is suspended", () => {
    expect(isEligible({ ...base, isSuspended: true })).toBe(false)
  })

  it("is false when email is null", () => {
    expect(isEligible({ ...base, email: null })).toBe(false)
  })

  it("is false when userId or phone is null", () => {
    expect(isEligible({ ...base, userId: null })).toBe(false)
    expect(isEligible({ ...base, phone: null })).toBe(false)
  })

  it("is false when matchCount is zero", () => {
    expect(isEligible({ ...base, matchCount: 0, verifiedCount: 0 })).toBe(false)
  })
})

describe("uaLabel", () => {
  it("returns 'Unknown device' for null", () => {
    expect(uaLabel(null)).toBe("Unknown device")
  })

  it("labels Chrome on Android", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
    expect(uaLabel(ua)).toBe("Chrome on Android")
  })

  it("labels Safari on iPhone", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1"
    expect(uaLabel(ua)).toBe("Safari on iOS")
  })

  it("labels Edge on Windows before Chrome", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"
    expect(uaLabel(ua)).toBe("Edge on Windows")
  })

  it("falls back to 'Unknown device' for an unrecognised agent", () => {
    expect(uaLabel("curl/8.0")).toBe("Unknown device")
  })

  it("never exceeds 40 characters", () => {
    const ua = "Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0 Mobile Safari/537.36"
    expect(uaLabel(ua).length).toBeLessThanOrEqual(40)
  })
})
