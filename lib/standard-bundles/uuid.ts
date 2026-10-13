type CryptoLike = { randomUUID?: () => string; getRandomValues?: <T extends Uint8Array>(a: T) => T }

/**
 * RFC 4122 v4 UUID for client idempotency keys. `crypto.randomUUID` is missing on older Android WebViews and in
 * non-secure (http) contexts, so fall back to `crypto.getRandomValues`, and as a last resort to Math.random (the key
 * only needs to be unique per user, not secret).
 */
export function newUuid(c: CryptoLike | undefined = typeof crypto !== "undefined" ? (crypto as CryptoLike) : undefined): string {
  if (c && typeof c.randomUUID === "function") {
    try { return c.randomUUID() } catch { /* fall through */ }
  }
  const b = new Uint8Array(16)
  let filled = false
  if (c && typeof c.getRandomValues === "function") {
    try { c.getRandomValues(b); filled = true } catch { /* fall through */ }
  }
  if (!filled) for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6] & 0x0f) | 0x40 // version 4
  b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
  const h = Array.from(b, x => x.toString(16).padStart(2, "0")).join("")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
