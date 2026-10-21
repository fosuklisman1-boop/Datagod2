// lib/refunds/hubtel-refund.ts
// Client for Hubtel's refund API, reached through the DO relay (Hubtel only accepts whitelisted IPs),
// plus the HMAC token that authenticates Hubtel's refund callback.
import { createHmac, timingSafeEqual } from "crypto"
import type { GatewayOutcome } from "./types"

/** Reuses the Commission Services callback secret, domain-separated so tokens never cross over. */
function tokenSecret(): string {
  return process.env.HUBTEL_CS_CALLBACK_SECRET ?? ""
}

export function signCallbackToken(refundId: string): string {
  const secret = tokenSecret()
  if (!secret) throw new Error("HUBTEL_CS_CALLBACK_SECRET is not set")
  return createHmac("sha256", secret).update(`hubtel-refund:${refundId}`).digest("hex")
}

export function verifyCallbackToken(refundId: string, token: string): boolean {
  try {
    if (!tokenSecret() || typeof token !== "string") return false
    const expected = Buffer.from(signCallbackToken(refundId))
    const given = Buffer.from(token)
    return expected.length === given.length && timingSafeEqual(expected, given)
  } catch {
    return false
  }
}

export function buildCallbackUrl(refundId: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL
  if (!base) throw new Error("NEXT_PUBLIC_APP_URL is not set")
  const token = signCallbackToken(refundId) // throws when the secret is missing
  return `${base.replace(/\/$/, "")}/api/webhooks/hubtel-refund?refund=${encodeURIComponent(refundId)}&t=${token}`
}

const PENDING_CODES = new Set(["0001", "4515"]) // accepted / already in progress
const REJECTED_CODES = new Set(["3000", "4000", "4509"]) // Hubtel definitively refused

/** Pure. For a pending outcome `ref` is Hubtel's data.orderId when present, else "" (4515 has data: null). */
export function classifyRefundReply(upstreamStatus: number, body: unknown): GatewayOutcome {
  const b = body && typeof body === "object" ? (body as any) : null
  const code = b && typeof b.responseCode === "string" ? b.responseCode : null
  if (code && PENDING_CODES.has(code)) {
    const orderId = b.data?.orderId
    return { kind: "pending", ref: typeof orderId === "string" ? orderId : "" }
  }
  if (code && REJECTED_CODES.has(code)) {
    const msg = typeof b.message === "string" && b.message ? b.message : `Hubtel refused the refund (${code})`
    return { kind: "failed", error: msg }
  }
  return { kind: "unknown", error: `hubtel refund ${upstreamStatus}: ${JSON.stringify(body ?? null).slice(0, 200)}` }
}

/** Asks Hubtel (via the relay) to refund a collection. Never throws. */
export async function requestHubtelRefund(
  hubtelOrderId: string, refundId: string, fetchImpl: typeof fetch = fetch,
): Promise<GatewayOutcome> {
  const url = process.env.HUBTEL_RELAY_URL
  const secret = process.env.HUBTEL_RELAY_SECRET
  if (!url || !secret) return { kind: "failed", error: "relay not configured" }
  let callbackUrl: string
  try {
    callbackUrl = buildCallbackUrl(refundId)
  } catch (e: any) {
    return { kind: "failed", error: String(e?.message ?? e) }
  }
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, "")}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ orderId: hubtelOrderId, callbackUrl }),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) return { kind: "failed", error: "Hubtel relay has not been updated to support refunds" }
    const json: any = await res.json().catch(() => null)
    if (!res.ok || typeof json?.upstreamStatus !== "number") {
      return { kind: "unknown", error: `relay ${res.status}: ${JSON.stringify(json ?? null).slice(0, 200)}` }
    }
    const outcome = classifyRefundReply(json.upstreamStatus, json.body)
    // Callback orderId check needs the id we sent; 4515 bodies carry none.
    return outcome.kind === "pending" ? { kind: "pending", ref: hubtelOrderId } : outcome
  } catch (e: any) {
    return { kind: "unknown", error: String(e?.message ?? e) }
  }
}
