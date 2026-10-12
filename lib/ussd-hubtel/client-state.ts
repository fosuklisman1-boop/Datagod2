// lib/ussd-hubtel/client-state.ts
// Hubtel echoes the ClientState of our previous reply on the next request. We put a signed
// snapshot of the session in it, so a session whose stored row is gone (expired, DB blip) can be
// rebuilt from the request itself. The snapshot is exactly the state behind the screen the caller
// is answering, so it is never "stale" for that request.
//
// Format: "<step>|<base64url(JSON {s: sessionId, e: expiry epoch s, d: session})>.<sig>"
// sig = HMAC-SHA256(HUBTEL_WEBHOOK_SECRET, "<step>|<payload>"), base64url, first 22 chars.
// The step prefix keeps the value readable in logs. Without the secret (tests, misconfigured env)
// or when the snapshot is too large, ClientState is the bare step name, as before.
import crypto from "crypto"
import type { HubtelSession, HubtelStep } from "./types"

/** How long a snapshot may be used after it was sent. */
export const CLIENT_STATE_TTL_SECONDS = 600
/** Hubtel documents no limit; stay well under typical gateway field sizes. */
export const CLIENT_STATE_MAX_LENGTH = 2000

const secret = () => process.env.HUBTEL_WEBHOOK_SECRET || ""

function sign(body: string, key: string): string {
  return crypto.createHmac("sha256", key).update(body).digest("base64url").slice(0, 22)
}

export function encodeClientState(sessionId: string, session: HubtelSession, nowMs = Date.now()): string {
  const key = secret()
  if (!key) return session.step
  const payload = Buffer.from(JSON.stringify({ s: sessionId, e: Math.floor(nowMs / 1000) + CLIENT_STATE_TTL_SECONDS, d: session })).toString("base64url")
  const body = `${session.step}|${payload}`
  const value = `${body}.${sign(body, key)}`
  return value.length <= CLIENT_STATE_MAX_LENGTH ? value : session.step
}

/** The session carried by `value`, or null unless it is signed by us, for this session, unexpired and well-formed. */
export function decodeClientState(value: string, sessionId: string, nowMs = Date.now()): HubtelSession | null {
  const key = secret()
  if (!key || !value) return null
  const dot = value.lastIndexOf(".")
  if (dot < 0) return null
  const body = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  const expected = sign(body, key)
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  const bar = body.indexOf("|")
  if (bar < 0) return null
  try {
    const parsed = JSON.parse(Buffer.from(body.slice(bar + 1), "base64url").toString("utf8")) as { s?: unknown; e?: unknown; d?: unknown }
    if (parsed.s !== sessionId || typeof parsed.e !== "number" || parsed.e * 1000 < nowMs) return null
    const d = parsed.d as HubtelSession | undefined
    if (!d || typeof d !== "object" || typeof d.step !== "string" || d.step !== body.slice(0, bar)) return null
    return d
  } catch {
    return null
  }
}

/** The step a ClientState names, signed or not (for logs and the bare-step-name fallback). */
export function clientStateStep(value: string): HubtelStep | "" {
  return (value.split("|")[0] ?? "") as HubtelStep | ""
}
