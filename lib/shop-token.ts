import crypto from "crypto"

// HMAC-signed proof that this request came from a real browser that loaded
// a /shop/* page (the middleware sets this cookie). The cookie is not bound
// to a specific shop — combined with IP rate limit, DB caps, and bad-UA
// blocking, it raises the cost of scripted attacks significantly.

const SECRET = process.env.SHOP_TOKEN_SECRET || "fallback-dev-secret-change-in-prod"

export function verifyShopSession(cookie: string): { valid: boolean; reason?: string } {
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
    if (Date.now() > payload.exp) return { valid: false, reason: "expired" }

    return { valid: true }
  } catch {
    return { valid: false, reason: "parse_error" }
  }
}
