// Pure helpers for phone-number login. No database or request access here so
// every rule can be unit-tested in isolation.

import { createHash, randomBytes } from "node:crypto"
import { ghanaSignificant, normalizeGhanaPhone } from "@/lib/phone-format"

export const GENERIC_LOGIN_ERROR = "Phone number or password is incorrect."
export const PHONE_LOGIN_PURPOSE = "phone_login"

export const LIMITS = {
  ipStep1: { max: 10, windowMs: 900_000 },
  ipVerify: { max: 10, windowMs: 900_000 },
  challengeTtlMs: 600_000,
  maxCodeAttempts: 5,
  resendGapMs: 60_000,
  deviceTtlMs: 2_592_000_000,
  maxDevices: 10,
} as const

/**
 * Normalise any accepted Ghana mobile format. `sig` is the 9 significant digits
 * (the lookup key used for hashing); `canonical` is the stored 0XXXXXXXXX form.
 */
export function phoneKey(input: string): { sig: string; canonical: string } | null {
  const sig = ghanaSignificant(input)
  const canonical = normalizeGhanaPhone(input)
  if (!sig || !canonical) return null
  return { sig, canonical }
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

export function phoneHash(sig: string): string {
  return sha256Hex("phone-login:" + sig)
}

export function ipHash(ip: string): string {
  return sha256Hex("phone-login-ip:" + ip)
}

/** 32 random bytes as base64url (43 characters, no padding). */
export function newToken(): string {
  return randomBytes(32).toString("base64url")
}

/** "0241234567" -> "024 *** **67". Input is expected to be canonical. */
export function maskPhone(canonical: string): string {
  return `${canonical.slice(0, 3)} *** **${canonical.slice(-2)}`
}

export type Account = {
  matchCount: number
  verifiedCount: number
  userId: string | null
  email: string | null
  phone: string | null
  phoneVerified: boolean
  isSuspended: boolean
}

/**
 * An account may log in by phone only when exactly one account holding the
 * number is verified on it (other accounts may be unverified squatters), the
 * account is not suspended, and it has the identifiers needed to sign in.
 */
export function isEligible(
  a: Account,
): a is Account & { userId: string; email: string; phone: string } {
  return (
    a.verifiedCount === 1 &&
    a.phoneVerified &&
    !a.isSuspended &&
    a.userId !== null &&
    a.email !== null &&
    a.phone !== null
  )
}

const MAX_UA_LABEL = 40

/** Short human label for a user agent, e.g. "Chrome on Android". */
export function uaLabel(userAgent: string | null): string {
  if (!userAgent) return "Unknown device"

  let browser: string | null = null
  if (/Edg\//.test(userAgent)) browser = "Edge"
  else if (/OPR\//.test(userAgent)) browser = "Opera"
  else if (/Firefox\//.test(userAgent)) browser = "Firefox"
  else if (/CriOS\//.test(userAgent)) browser = "Chrome"
  else if (/Chrome\//.test(userAgent)) browser = "Chrome"
  else if (/Safari\//.test(userAgent)) browser = "Safari"

  let os: string | null = null
  if (/Android/.test(userAgent)) os = "Android"
  else if (/iPhone|iPad|iPod/.test(userAgent)) os = "iOS"
  else if (/Windows/.test(userAgent)) os = "Windows"
  else if (/Macintosh|Mac OS X/.test(userAgent)) os = "macOS"
  else if (/Linux/.test(userAgent)) os = "Linux"

  if (!browser && !os) return "Unknown device"
  const label = browser && os ? `${browser} on ${os}` : (browser ?? os ?? "Unknown device")
  return label.slice(0, MAX_UA_LABEL)
}
