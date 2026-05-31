import crypto from "crypto"

// HMAC-signed proof that this request came from a real browser that loaded
// a /shop/* page (the middleware sets this cookie). The cookie is not bound
// to a specific shop — combined with IP rate limit, DB caps, and bad-UA
// blocking, it raises the cost of scripted attacks significantly.

// Must match the fallback in lib/shop-token-edge.ts exactly — both sides need the same secret
// to produce/verify matching HMACs. SHOP_TOKEN_SECRET env var takes precedence in prod.
const SECRET = process.env.SHOP_TOKEN_SECRET || "e2d05114cd141aaa7ea91b01dce67e192feea2ed86f76daafb7ea19c24b182a8"
const REQUIRED_VERSION = 3 // matches lib/shop-token-edge.ts

// Verifies the cookie's HMAC, expiry, version, AND optional slug binding.
// Pass `expectedSlug` (the shop's current DB slug) to require the cookie
// was issued for that exact shop. Omit to skip slug binding.
export function verifyShopSession(cookie: string, expectedSlug?: string): { valid: boolean; reason?: string } {
  try {
    const dot = cookie.lastIndexOf(".")
    if (dot === -1) return { valid: false, reason: "malformed" }

    const data = cookie.slice(0, dot)
    const sig = cookie.slice(dot + 1)

    const expected = crypto.createHmac("sha256", SECRET).update(data).digest("base64url")
    const sigBuf = Buffer.from(sig, "base64url")
    const expBuf = Buffer.from(expected, "base64url")
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, reason: "invalid_signature" }
    }

    const payload = JSON.parse(Buffer.from(data, "base64url").toString())
    if (payload.v !== REQUIRED_VERSION) return { valid: false, reason: "stale_version" }
    if (Date.now() > payload.exp) return { valid: false, reason: "expired" }
    if (expectedSlug && payload.slug !== expectedSlug) {
      return { valid: false, reason: "slug_mismatch" }
    }

    return { valid: true }
  } catch {
    return { valid: false, reason: "parse_error" }
  }
}
