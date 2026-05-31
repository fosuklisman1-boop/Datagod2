import crypto from "crypto"

const SECRET = process.env.SHOP_TOKEN_SECRET || "fallback-dev-secret-change-in-prod"
const TTL_MS = 15 * 60 * 1000 // 15 minutes

export function generateShopToken(shopId: string): string {
  const payload = {
    shopId,
    exp: Date.now() + TTL_MS,
    nonce: crypto.randomBytes(8).toString("hex"),
  }
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const sig = crypto.createHmac("sha256", SECRET).update(data).digest("base64url")
  return `${data}.${sig}`
}

export function verifyShopToken(token: string, shopId: string): { valid: boolean; reason?: string } {
  try {
    const [data, sig] = token.split(".")
    if (!data || !sig) return { valid: false, reason: "malformed" }

    const expected = crypto.createHmac("sha256", SECRET).update(data).digest("base64url")
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
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
