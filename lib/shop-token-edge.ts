// Edge-runtime compatible signer for the __shop_sess cookie.
// Imported by middleware.ts (Edge runtime — no Node `crypto` module).
// Verification stays in lib/shop-token.ts which runs in Node route handlers.

const SECRET = process.env.SHOP_TOKEN_SECRET || "fallback-dev-secret-change-in-prod"
const TTL_MS = 10 * 60 * 1000

const encoder = new TextEncoder()

function base64urlFromBytes(bytes: Uint8Array): string {
  let str = ""
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i])
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function generateShopSession(): Promise<string> {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(8))
  const payload = {
    exp: Date.now() + TTL_MS,
    nonce: base64urlFromBytes(nonceBytes),
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
