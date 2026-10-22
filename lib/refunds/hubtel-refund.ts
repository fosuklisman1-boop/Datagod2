// lib/refunds/hubtel-refund.ts
// Client for Hubtel's refund API, reached through the DO relay (Hubtel only accepts whitelisted IPs),
// plus the HMAC token that authenticates Hubtel's refund callback.
import { createHmac, timingSafeEqual } from "crypto"
import type { GatewayOutcome } from "./types"

/** Dedicated refund-callback secret (not shared with Commission Services). */
function tokenSecret(): string {
  return process.env.HUBTEL_REFUND_CALLBACK_SECRET ?? ""
}

export function signCallbackToken(refundId: string): string {
  const secret = tokenSecret()
  if (!secret) throw new Error("HUBTEL_REFUND_CALLBACK_SECRET is not set")
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
  return `${base.replace(/\/$/, "")}/api/webhooks/hubtel-refund?refund=${encodeURIComponent(refundId)}&t=${encodeURIComponent(token)}`
}

const PENDING_CODES = new Set(["0001", "4515"]) // accepted / already in progress
const REJECTED_CODES = new Set(["3000", "4000", "4509"]) // Hubtel definitively refused

/** Pure. For a pending outcome `ref` is Hubtel's data.orderId when present, else "" (4515 has data: null). */
export function classifyRefundReply(upstreamStatus: number, body: unknown): GatewayOutcome {
  const b = body && typeof body === "object" ? (body as any) : null
  const code = b && typeof b.responseCode === "string" ? b.responseCode : null
  if (code && PENDING_CODES.has(code)) {
    const orderId = b.data && typeof b.data === "object" ? b.data.orderId : undefined
    return { kind: "pending", ref: typeof orderId === "string" ? orderId : "" }
  }
  if (code && REJECTED_CODES.has(code)) {
    const msg = typeof b.message === "string" && b.message ? b.message : `Hubtel refused the refund (${code})`
    if (code === "4509") {
      return { kind: "failed", error: `Hubtel 4509: not eligible — it may already have been refunded by Hubtel; check Hubtel before refunding another way. ${msg}` }
    }
    return { kind: "failed", error: msg }
  }
  // Hubtel's front door (auth / IP whitelist) refused the call before any processing, so no money can have
  // moved. The body is usually HTML; it is deliberately left out of the error so no markup reaches the ledger.
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return {
      kind: "failed",
      error: `Hubtel refused the refund request (HTTP ${upstreamStatus}) — the relay's IP is probably not whitelisted for the refund API, or the credential was rejected. Nothing was processed.`,
    }
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
    // The relay refused before calling Hubtel, so no money can have moved: these are definite failures.
    if (res.status === 404) return { kind: "failed", error: "Hubtel relay has not been updated to support refunds" }
    if (res.status === 400) return { kind: "failed", error: "Hubtel relay rejected the request (invalid order id or callback URL)" }
    if (res.status === 401 || res.status === 403) return { kind: "failed", error: "Hubtel relay authentication failed — check HUBTEL_RELAY_SECRET" }
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
