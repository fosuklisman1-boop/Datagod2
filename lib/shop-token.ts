import crypto from "crypto"

const SECRET = process.env.SHOP_TOKEN_SECRET || "fallback-dev-secret-change-in-prod"
const TTL_MS = 30 * 60 * 1000 // 30 minutes

export function generateShopCookie(shopId: string): string {
  const payload = {
    shopId,
    exp: Date.now() + TTL_MS,
    nonce: crypto.randomBytes(8).toString("hex"),
  }
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const sig = crypto.createHmac("sha256", SECRET).update(data).digest("base64url")
  return `${data}.${sig}`
}

export function verifyShopCookie(cookie: string, shopId: string): { valid: boolean; reason?: string } {
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
    if (payload.shopId !== shopId) return { valid: false, reason: "shop_mismatch" }

    return { valid: true }
  } catch {
    return { valid: false, reason: "parse_error" }
  }
}
