import crypto from "crypto"

// Charset deliberately excludes 0/O, 1/I/L to avoid customer confusion when
// reading reference codes aloud or off a screen. 32 chars = 5 bits per char.
const SAFE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/**
 * Cryptographically-secure random string from a custom charset.
 * Uses rejection-free modulo over crypto.randomBytes — slight bias for non-power-of-2
 * charsets but acceptable for reference codes (not for cryptographic key material).
 */
export function secureString(length: number, charset: string = SAFE_CHARS): string {
  if (length <= 0) return ""
  const bytes = crypto.randomBytes(length)
  let s = ""
  for (let i = 0; i < length; i++) {
    s += charset[bytes[i] % charset.length]
  }
  return s
}

/**
 * Generate a reference code like `PREFIX-XXX-XXX` with secure randomness.
 * 3 segments × 3 chars at 5 bits each = 45 bits = ~35 trillion combinations.
 */
export function secureReference(prefix: string, segments: number = 2, segmentLength: number = 3): string {
  const parts: string[] = []
  for (let i = 0; i < segments; i++) parts.push(secureString(segmentLength))
  return `${prefix}-${parts.join("-")}`
}

/**
 * Generate a long order reference combining a timestamp + secure random.
 * Format matches the original shop_orders ORD-<ts>-<random9> pattern.
 */
export function secureTimestampedReference(prefix: string, randomLength: number = 9): string {
  return `${prefix}-${Date.now()}-${secureString(randomLength)}`
}

/**
 * Generate a numeric code (digits only) of given length.
 */
export function secureNumericCode(length: number): string {
  return secureString(length, "0123456789")
}
