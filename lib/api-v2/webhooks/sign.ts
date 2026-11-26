// Release 6 webhook signing. Header: Datagod-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>.
// verifySignature is what the docs tell receivers to do; it is also used by the tests.
import { createHmac, randomBytes, timingSafeEqual } from "crypto"

/** whsec_ + 32 random bytes, base64url (43 characters). */
export function newSecret(): string {
  return "whsec_" + randomBytes(32).toString("base64url")
}

const hmac = (secret: string, t: number, body: string) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")

export function signatureHeader(secret: string, body: string, tSeconds: number): string {
  return `t=${tSeconds},v1=${hmac(secret, tSeconds, body)}`
}

/** True only for a v1 match whose timestamp is within toleranceSec of nowSec. */
export function verifySignature(secret: string, body: string, header: string, nowSec: number, toleranceSec = 300): boolean {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(String(header ?? "").trim())
  if (!m) return false
  const t = Number(m[1])
  if (Math.abs(nowSec - t) > toleranceSec) return false
  const want = Buffer.from(hmac(secret, t, body), "hex")
  const got = Buffer.from(m[2], "hex")
  return want.length === got.length && timingSafeEqual(want, got)
}
