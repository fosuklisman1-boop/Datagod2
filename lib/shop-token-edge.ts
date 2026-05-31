// Edge-runtime compatible signer for the __shop_sess cookie.
// Imported by middleware.ts (Edge runtime — no Node `crypto` module).
// Verification stays in lib/shop-token.ts which runs in Node route handlers.

// Fallback is intentionally a fresh random value — old fallback was leaked via git history.
// SHOP_TOKEN_SECRET in Vercel takes precedence; this is only used if the env var is missing.
const SECRET = process.env.SHOP_TOKEN_SECRET || "e2d05114cd141aaa7ea91b01dce67e192feea2ed86f76daafb7ea19c24b182a8"
const TTL_MS = 10 * 60 * 1000
const COOKIE_VERSION = 3 // bumped: slug is now part of the payload

const encoder = new TextEncoder()

function base64urlFromBytes(bytes: Uint8Array): string {
  let str = ""
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i])
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// Issues a cookie bound to a specific shop slug. A cookie issued for `/shop/A`
// will fail validation against any order placed against shop B.
export async function generateShopSession(slug: string): Promise<string> {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(8))
  const payload = {
    v: COOKIE_VERSION,
    exp: Date.now() + TTL_MS,
    nonce: base64urlFromBytes(nonceBytes),
    slug,
  }
  const data = base64urlFromBytes(encoder.encode(JSON.stringify(payload)))

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(data))
  const sig = base64urlFromBytes(new Uint8Array(sigBuf))

  return `${data}.${sig}`
}
