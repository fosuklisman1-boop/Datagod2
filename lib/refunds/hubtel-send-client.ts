// lib/refunds/hubtel-send-client.ts
// Vercel-side client for Hubtel Direct Send Money (refund payouts), via the DO relay (/send, /send-status).
// Never calls Hubtel directly. Money goes OUT here, so the rule is: `failed` only when money definitely did not
// move; everything ambiguous is `unknown` (a send) or `pending` (a status check). A repeat attempt for the same
// refund always reuses the same ClientReference, so Hubtel's duplicate rule (HT-S0001) blocks a second payment.
import { signRef, verifySig } from "@/lib/hubtel-cs/callback"
import { failedBeforeSend } from "@/lib/ussd-hubtel/relay-handler"
import { detectGhanaNetwork, ghanaSignificant } from "@/lib/phone-format"
import type { RelayReply } from "@/lib/hubtel-pay/client"
import type { GatewayOutcome } from "./types"

type Env = Record<string, string | undefined>
export interface SendDeps {
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  env?: Env
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REF_RE = /^[0-9a-f]{32}$/
/** Longer than the relay's own 8s upstream timeout, so the relay normally answers first. */
const RELAY_TIMEOUT_MS = 15_000

/** The refund id's UUID without dashes: 32 lowercase hex, opaque (no surface or product word), identical on any repeat. */
export function sendRefundReference(refundId: string): string {
  if (typeof refundId !== "string" || !UUID_RE.test(refundId)) throw new Error("refund id must be a UUID")
  return refundId.replace(/-/g, "").toLowerCase()
}

/** Any Ghana mobile format -> 233XXXXXXXXX (what Hubtel wants), or null. */
export function toHubtelMsisdn(phone: string): string | null {
  const sig = ghanaSignificant(phone)
  return sig ? `233${sig}` : null
}

export type HubtelChannel = "mtn-gh" | "vodafone-gh" | "tigo-gh"
export const HUBTEL_CHANNELS: readonly HubtelChannel[] = ["mtn-gh", "vodafone-gh", "tigo-gh"]
export const isHubtelChannel = (v: unknown): v is HubtelChannel => typeof v === "string" && (HUBTEL_CHANNELS as readonly string[]).includes(v)

/** Channel from the number's prefix. A ported number can differ: prefer the channel Hubtel stored when the payer paid. */
export function hubtelChannelFor(phone: string): HubtelChannel | null {
  switch (detectGhanaNetwork(phone)) {
    case "MTN": return "mtn-gh"
    case "TELECEL": return "vodafone-gh"
    case "AT": return "tigo-gh"
    default: return null
  }
}

const asObject = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null)

/** Short, single-line, digit-run-free text for a stored note: no msisdn or account number can leak through it. */
const clean = (v: unknown): string => {
  const s = typeof v === "string" ? v : ""
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\d{7,}/g, "…").slice(0, 120)
}

const isRelayOwnError = (body: unknown): boolean => {
  const o = asObject(body)
  return !!o && Object.keys(o).length === 1 && typeof o.error === "string"
}

/** Hubtel codes meaning nothing was sent: balance too low, number not on MoMo, request rejected as invalid. */
const NOT_SENT_CODES = new Set(["4075", "3050", "4000"])
/** Codes that mean accepted / processed: they contradict a rejected HTTP status. */
const ACCEPT_CODES = new Set(["0000", "0001"])
/** Hubtel HTTP statuses that mean rejected, not processed. */
const REFUSED_HTTP = new Set([401, 403, 404, 405])

/**
 * Pure. Classifies the relay's reply to POST /send. `ref` is the ClientReference we sent (used as the stored
 * reference when Hubtel gives no transaction id).
 */
export function classifySend(reply: RelayReply, ref: string): GatewayOutcome {
  if (reply.kind === "not_configured") return { kind: "failed", error: "Hubtel relay is not configured — nothing was sent" }
  if (reply.kind === "transport_error") {
    if (failedBeforeSend(reply.error)) return { kind: "failed", error: "Hubtel relay unreachable — nothing was sent" }
    return { kind: "unknown", error: "Hubtel relay did not answer — the payout may have been sent; check status before retrying" }
  }

  const { httpStatus, json } = reply
  const j = asObject(json)
  if (httpStatus !== 200) {
    // The relay's own rejections ({error}) are all produced before anything is forwarded to Hubtel.
    if ([400, 401, 404, 405, 501].includes(httpStatus) && isRelayOwnError(json)) {
      return { kind: "failed", error: `Hubtel relay refused the request (${httpStatus}) — nothing was sent` }
    }
    return { kind: "unknown", error: `Hubtel relay answered ${httpStatus} — check status before retrying` }
  }
  if (!j || typeof j.sent !== "boolean" || typeof j.upstreamStatus !== "number") {
    return { kind: "unknown", error: "Hubtel relay reply was unreadable — check status before retrying" }
  }
  const up: number = j.upstreamStatus
  if (j.sent === false) {
    if (up === 0) return { kind: "failed", error: "The request never left the relay — nothing was sent" }
    return { kind: "unknown", error: "Hubtel relay reply was contradictory — check status before retrying" }
  }
  if (up === 0) return { kind: "unknown", error: "Hubtel did not answer in time — the payout may have been sent; check status before retrying" }
  if (up >= 500) return { kind: "unknown", error: `Hubtel answered ${up} — the payout may have been sent; check status before retrying` }

  const body = asObject(j.body)
  const rawCode = body?.ResponseCode
  const code = typeof rawCode === "string" ? rawCode : null
  const data = asObject(body?.Data)
  const why = clean(data?.Description) || (code ? `code ${clean(code)}` : "")

  if (REFUSED_HTTP.has(up)) {
    if (code && ACCEPT_CODES.has(code)) return { kind: "unknown", error: `HTTP ${up} contradicted by code ${code} — check status before retrying` }
    return { kind: "failed", error: `Hubtel rejected the request (HTTP ${up}) — nothing was sent` }
  }
  if (up < 200 || up >= 500 || (up >= 300 && up < 400)) return { kind: "unknown", error: `Hubtel answered ${up} — check status before retrying` }
  if (!code) return { kind: "unknown", error: "Hubtel reply had no response code — check status before retrying" }

  const tx = typeof data?.TransactionId === "string" && data.TransactionId ? data.TransactionId : ref
  if (code === "0001" && up < 300) return { kind: "pending", ref: tx }
  if (code === "0000" && up < 300) return { kind: "completed", ref: tx }
  if (NOT_SENT_CODES.has(code)) return { kind: "failed", error: `Hubtel did not send the payout (${code}${why ? `: ${why}` : ""})` }
  // 2001 is ambiguous in Hubtel's docs (processor error, invalid number or duplicate reference), 5000 and the rest too.
  return { kind: "unknown", error: `Hubtel answered ${code}${why ? ` (${why})` : ""} — check status before retrying` }
}

/**
 * Pure. Classifies the relay's reply to GET /send-status. Only an exact success (our reference, our amount) completes,
 * and only an explicit "failed" for our reference fails: the mapping is an allowlist until the supervised live test
 * records Hubtel's real failed values. No match (Hubtel answers HTTP 400 "did not match any records") and anything
 * else stay `pending`. No answer at all is `unknown`, which also keeps the row processing.
 */
export function classifySendStatus(reply: RelayReply, want: { reference: string; amount: number }): GatewayOutcome {
  if (reply.kind === "not_configured") return { kind: "unknown", error: "Hubtel relay is not configured — status not checked" }
  if (reply.kind === "transport_error") return { kind: "unknown", error: "Could not reach the Hubtel relay to check status" }
  const j = asObject(reply.json)
  if (reply.httpStatus !== 200 || !j || typeof j.upstreamStatus !== "number") {
    return { kind: "unknown", error: `Hubtel relay status check answered ${reply.httpStatus} — status not checked` }
  }
  if (j.upstreamStatus === 0) return { kind: "unknown", error: "Hubtel did not answer the status check" }

  const pending: GatewayOutcome = { kind: "pending", ref: want.reference }
  const body = asObject(j.body)
  const data = asObject(body?.Data)
  if (!body || !data || data.ClientReference !== want.reference) return pending

  const status = typeof data.transactionStatus === "string" ? data.transactionStatus.toLowerCase() : ""
  const up: number = j.upstreamStatus
  if (status === "success") {
    const topCode = typeof body.ResponseCode === "string" ? body.ResponseCode.toLowerCase() : ""
    if (up < 200 || up >= 300 || (topCode !== "success" && topCode !== "0000")) return pending
    const amount = typeof data.Amount === "number" ? data.Amount : NaN
    if (!Number.isFinite(amount) || Math.abs(amount - want.amount) > 0.005) {
      return { kind: "unknown", error: "Hubtel reports success for a different amount — review before resolving" }
    }
    return { kind: "completed", ref: typeof data.TransactionId === "string" && data.TransactionId ? data.TransactionId : want.reference }
  }
  if (status === "failed") return { kind: "failed", error: "Hubtel reports the payout failed" }
  return pending
}

/**
 * What an admin needs to decide on a stuck payout. Deliberately separate from classifySendStatus, which only settles on
 * an exact match; this one reads wider on paid, and fails safe: any word that might mean paid is `success`, and only the
 * word "failed" or Hubtel's exact no-match answer can let an admin mark the refund failed. Update the words after the
 * supervised live test records Hubtel's real values.
 */
export type SendStatusVerdict = "success" | "failed" | "no_record" | "unclear" | "no_answer"
export interface SendStatusView {
  verdict: SendStatusVerdict
  upstreamStatus: number | null
  /** Hubtel's reply with every long digit run masked: no phone number reaches the screen or the audit log. */
  raw: unknown
}

const MAYBE_PAID = /succ|paid|complet|deliver/i
/** Hubtel's own wording, seen live 2026-11-05. A generic "not found" could be a proxy or a wrong account, not this payout. */
const NO_MATCH = /did not match any records/i

/** Masks digit runs that could be a phone number, in strings and numbers, at any depth. */
function maskDigits(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.replace(/\d{7,}/g, "…")
  if (typeof v === "number") return Math.abs(v) >= 1_000_000 ? "…" : v
  if (depth > 6 || v === null || typeof v !== "object") return v === undefined || typeof v === "boolean" || v === null ? v : null
  if (Array.isArray(v)) return v.map((x) => maskDigits(x, depth + 1))
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDigits(x, depth + 1)]))
}

/** Pure. Reads the relay's reply to GET /send-status. `reference` is the ClientReference we sent. */
export function readSendStatus(reply: RelayReply, reference: string): SendStatusView {
  if (reply.kind !== "reply") return { verdict: "no_answer", upstreamStatus: null, raw: null }
  const j = asObject(reply.json)
  if (reply.httpStatus !== 200 || !j || typeof j.upstreamStatus !== "number" || j.upstreamStatus === 0) {
    return { verdict: "no_answer", upstreamStatus: j && typeof j.upstreamStatus === "number" ? j.upstreamStatus : null, raw: maskDigits(reply.json) }
  }
  const up: number = j.upstreamStatus
  const view = (verdict: SendStatusVerdict): SendStatusView => ({ verdict, upstreamStatus: up, raw: maskDigits(j.body) })
  const body = asObject(j.body)
  const data = asObject(body?.Data)
  if (data && data.ClientReference === reference) {
    const word = typeof data.transactionStatus === "string" ? data.transactionStatus : ""
    if (MAYBE_PAID.test(word)) return view("success")
    // The same single word classifySendStatus accepts. A wrong "failed" allows a retry under a new reference.
    if (word.trim().toLowerCase() === "failed") return view("failed")
    return view("unclear")
  }
  const code = typeof body?.ResponseCode === "string" ? body.ResponseCode.toLowerCase() : ""
  if (up === 400 && code === "error" && typeof body?.Data === "string" && NO_MATCH.test(body.Data)) return view("no_record")
  return view("unclear")
}

// ---------------------------------------------------------------------------------------------------------------
// Callback URL. The signature covers "send:" + ref, so a collection-callback or return signature can never open it.

const sendPayload = (reference: string) => `send:${reference}`

export function verifySendSig(reference: string | null, sig: string | null, secret: string): boolean {
  if (!reference || !REF_RE.test(reference)) return false
  return verifySig(sendPayload(reference), sig, secret)
}

/** `${NEXT_PUBLIC_APP_URL}/api/webhooks/hubtel-send?ref=…&sig=…` */
export function hubtelSendCallbackUrl(reference: string, env: Env = process.env): string {
  if (!REF_RE.test(reference)) throw new Error("invalid Hubtel send reference")
  const secret = env.HUBTEL_PAYMENTS_CALLBACK_SECRET
  if (!secret || secret.length < 32) throw new Error("HUBTEL_PAYMENTS_CALLBACK_SECRET is not configured (must be at least 32 chars)")
  let base: URL
  try { base = new URL(env.NEXT_PUBLIC_APP_URL ?? "") } catch { throw new Error("NEXT_PUBLIC_APP_URL is not configured") }
  if (base.protocol !== "https:") throw new Error("NEXT_PUBLIC_APP_URL must be https")
  const u = new URL("/api/webhooks/hubtel-send", base)
  u.searchParams.set("ref", reference)
  u.searchParams.set("sig", signRef(sendPayload(reference), secret))
  return u.toString()
}

// ---------------------------------------------------------------------------------------------------------------
// Relay calls

async function callRelay(method: "POST" | "GET", pathAndQuery: string, payload: Record<string, unknown> | null, deps: SendDeps): Promise<RelayReply> {
  const env = deps.env ?? process.env
  const url = env.HUBTEL_RELAY_URL
  const secret = env.HUBTEL_RELAY_SECRET
  if (!url || !secret) return { kind: "not_configured" }
  const doFetch = deps.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(`${url.replace(/\/$/, "")}${pathAndQuery}`, {
      method,
      headers: { ...(payload ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${secret}` },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    })
  } catch (error) {
    return { kind: "transport_error", error }
  }
  // An unreadable body after a response is malformed (unknown), never a transport failure.
  const json = await res.json().catch(() => null)
  return { kind: "reply", httpStatus: res.status, json }
}

const validAmount = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && Math.round(v * 100) / 100 === v

export interface SendMoneyInput {
  refundId: string
  /** 233XXXXXXXXX */
  msisdn: string
  channel: string
  /** GHS, exactly 2 decimals */
  amount: number
}

/** Sends one refund payout. Never throws: every problem is a GatewayOutcome. A bad input means nothing was sent: failed. */
export async function sendMoney(p: SendMoneyInput, deps: SendDeps = {}): Promise<GatewayOutcome> {
  let reference: string
  let callbackUrl: string
  try {
    if (!validAmount(p.amount)) return { kind: "failed", error: "Invalid payout amount — nothing was sent" }
    reference = sendRefundReference(p.refundId)
    callbackUrl = hubtelSendCallbackUrl(reference, deps.env ?? process.env)
  } catch (e) {
    return { kind: "failed", error: `${e instanceof Error ? clean(e.message) : "Invalid payout request"} — nothing was sent` }
  }
  const reply = await callRelay("POST", "/send", { reference, msisdn: p.msisdn, channel: p.channel, amount: p.amount, callbackUrl }, deps)
  return classifySend(reply, reference)
}

/** Asks Hubtel (through the relay) for the status of this refund's payout. Never throws. */
export async function checkSendStatus(p: { refundId: string; amount: number }, deps: SendDeps = {}): Promise<GatewayOutcome> {
  let reference: string
  try { reference = sendRefundReference(p.refundId) } catch { return { kind: "unknown", error: "Invalid refund id — status not checked" } }
  const reply = await callRelay("GET", `/send-status?clientReference=${reference}`, null, deps)
  return classifySendStatus(reply, { reference, amount: p.amount })
}

/** The same status check, read for an admin (see readSendStatus). Read-only. Never throws. */
export async function describeSendStatus(p: { refundId: string; amount: number }, deps: SendDeps = {}): Promise<SendStatusView> {
  let reference: string
  try { reference = sendRefundReference(p.refundId) } catch { return { verdict: "no_answer", upstreamStatus: null, raw: null } }
  return readSendStatus(await callRelay("GET", `/send-status?clientReference=${reference}`, null, deps), reference)
}
