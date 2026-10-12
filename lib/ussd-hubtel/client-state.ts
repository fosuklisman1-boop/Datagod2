// lib/ussd-hubtel/client-state.ts
// Hubtel echoes the ClientState of our previous reply on the next request. We put a signed
// snapshot of the session in it, so a session whose stored row is gone (expired, DB blip) can be
// rebuilt from the request itself. The snapshot is exactly the state behind the screen the caller
// is answering, so it is never "stale" for that request.
//
// Format: "<step>|<base64url(iv 12 bytes | AES-256-GCM ciphertext | tag 16 bytes)>"
// The plaintext is JSON {s: sessionId, e: expiry epoch s, d: session}. ENCRYPTED, not just signed:
// the session can hold a Ghana Card number, voucher PIN, DOB and names, and ClientState passes
// through Hubtel. GCM authenticates it (tampering fails), and the step prefix is bound as AAD.
// The key is derived from HUBTEL_WEBHOOK_SECRET with a dedicated label, never the secret itself.
// Without the secret (tests, misconfigured env) or when the snapshot is too large, ClientState is
// the bare step name, as before.
import crypto from "crypto"
import type { HubtelSession, HubtelStep } from "./types"

/** How long a snapshot may be used after it was sent. */
export const CLIENT_STATE_TTL_SECONDS = 600
/** Hubtel documents no limit; stay well under typical gateway field sizes. */
export const CLIENT_STATE_MAX_LENGTH = 2000

const IV_BYTES = 12
const TAG_BYTES = 16

/** 32-byte key for this purpose only, derived from the webhook secret; null when the secret is unset. */
function key(): Buffer | null {
  const secret = process.env.HUBTEL_WEBHOOK_SECRET || ""
  return secret ? Buffer.from(crypto.hkdfSync("sha256", secret, "", "hubtel-ussd-client-state-v1", 32)) : null
}

export function encodeClientState(sessionId: string, session: HubtelSession, nowMs = Date.now()): string {
  const k = key()
  if (!k) return session.step
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv)
  cipher.setAAD(Buffer.from(session.step))
  const plain = JSON.stringify({ s: sessionId, e: Math.floor(nowMs / 1000) + CLIENT_STATE_TTL_SECONDS, d: session })
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const value = `${session.step}|${Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64url")}`
  return value.length <= CLIENT_STATE_MAX_LENGTH ? value : session.step
}

/** The session carried by `value`, or null unless it was sealed by us, for this session, unexpired and well-formed. */
export function decodeClientState(value: string, sessionId: string, nowMs = Date.now()): HubtelSession | null {
  const k = key()
  if (!k || !value || value.length > CLIENT_STATE_MAX_LENGTH) return null
  const bar = value.indexOf("|")
  if (bar < 0) return null
  const step = value.slice(0, bar)
  try {
    const raw = Buffer.from(value.slice(bar + 1), "base64url")
    if (raw.length <= IV_BYTES + TAG_BYTES) return null
    const decipher = crypto.createDecipheriv("aes-256-gcm", k, raw.subarray(0, IV_BYTES))
    decipher.setAAD(Buffer.from(step))
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES))
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString("utf8")
    const parsed = JSON.parse(plain) as { s?: unknown; e?: unknown; d?: unknown }
    if (parsed.s !== sessionId || typeof parsed.e !== "number" || parsed.e * 1000 < nowMs) return null
    const d = parsed.d as HubtelSession | undefined
    if (!d || typeof d !== "object" || d.step !== step) return null
    return d
  } catch {
    return null // bad tag (tampered / other key), malformed base64 or JSON
  }
}

/** The step a ClientState names, signed or not (for logs and the bare-step-name fallback). */
export function clientStateStep(value: string): HubtelStep | "" {
  return (value.split("|")[0] ?? "") as HubtelStep | ""
}
