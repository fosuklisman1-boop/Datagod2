import crypto from "node:crypto"
import { sm4CbcDecrypt, sm4CbcEncrypt } from "./sm4-block"

/**
 * SM4-CBC envelope for the forwarder phone's HTTP server. Server-only. Pure: no I/O, no logging.
 * SM4 is the pure-TypeScript implementation in sm4-block.ts (not the host's OpenSSL, which may lack it); only HMAC-SHA256 uses node:crypto.
 * The key is 16 bytes (32 hex chars); the IV is fixed by the phone app; padding is PKCS7; bodies are lowercase hex.
 */

const IV = Buffer.from([3, 5, 6, 9, 6, 9, 5, 9, 3, 5, 6, 9, 6, 9, 5, 9])

/** The 16-byte key for exactly 32 hex chars, else null. */
export function parseKey(hex: string): Buffer | null {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{32}$/.test(hex)) return null
  return Buffer.from(hex, "hex")
}

/** The hex ciphertext request body for one SMS send. */
export function buildSendBody(
  key: Buffer,
  keyHex: string,
  p: { simSlot: 1 | 2; to: string; text: string; nowMs: number },
): string {
  const ts = Math.trunc(p.nowMs)
  const sign = encodeURIComponent(crypto.createHmac("sha256", key).update(`${ts}\n${keyHex}`).digest("base64"))
  const plain = JSON.stringify({
    data: { sim_slot: p.simSlot, phone_numbers: p.to, msg_content: p.text },
    timestamp: ts,
    sign,
  })
  return sm4CbcEncrypt(key, IV, Buffer.from(plain, "utf8")).toString("hex")
}

/** The decoded reply of the phone, or null on any decode or parse failure. */
export function decodeResponse(key: Buffer, hexBody: string): { code: number; msg?: string } | null {
  try {
    if (typeof hexBody !== "string") return null
    const h = hexBody.trim()
    if (h === "" || h.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(h)) return null
    const buf = Buffer.from(h, "hex")
    if (buf.length % 16 !== 0) return null
    const dec = sm4CbcDecrypt(key, IV, buf)
    if (!dec) return null
    const plain = dec.toString("utf8")
    const j = JSON.parse(plain) as { code?: unknown; msg?: unknown }
    if (!j || typeof j !== "object" || typeof j.code !== "number") return null
    return typeof j.msg === "string" ? { code: j.code, msg: j.msg } : { code: j.code }
  } catch {
    return null
  }
}
