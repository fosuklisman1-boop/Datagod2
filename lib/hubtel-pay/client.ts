// lib/hubtel-pay/client.ts
// Vercel-side client for Hubtel collection, via the DO relay (/receive, /checkout, /status).
// Never calls Hubtel directly. Classification follows the plan 3 Global Constraints table:
// "refused" is the ONLY outcome that allows falling back to another gateway, so anything
// we cannot prove never reached Hubtel is "unknown".
import { signRef } from "@/lib/hubtel-cs/callback"
import { failedBeforeSend } from "@/lib/ussd-hubtel/relay-handler"
import { checkTransactionStatus, type StatusCheckResult } from "@/lib/ussd-hubtel/relay"

export type StartOutcome =
  | { kind: "accepted"; checkoutUrl?: string; hubtelTransactionId?: string }
  | { kind: "refused"; code: string; message: string; upstreamStatus?: number }
  | { kind: "unknown"; code: string; message: string; upstreamStatus?: number }

/** What came back from one call to the relay, before classification. */
export type RelayReply =
  | { kind: "reply"; httpStatus: number; json: unknown }
  | { kind: "transport_error"; error: unknown }
  | { kind: "not_configured" }

export type StartRoute = "receive" | "checkout"

/** Our own bad input (a programming bug), never a gateway outcome. */
export class HubtelPayInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HubtelPayInputError"
  }
}

type Env = Record<string, string | undefined>
export interface ClientDeps {
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  env?: Env
}

/** Hubtel codes that mean the request was rejected outright (nothing will be charged). */
const REFUSED_CODES = new Set(["4000", "4070", "4101", "4103"])
/**
 * Hubtel HTTP statuses that mean "rejected, not processed" (controller ruling, narrower than
 * "any 4xx"). 408/409/410/423/425/429/499 and other 4xx stay unknown: they can follow a request
 * Hubtel already holds.
 */
const REFUSED_HTTP = new Set([400, 401, 403, 404, 405, 413, 415, 422])
/** Codes meaning accepted/pending/processing: they contradict a refused HTTP status → unknown. */
const LIVE_CODES = new Set(["0000", "0001", "0005", "5000"])
/** Refusals caused by our setup, not the customer. */
const CONFIG_CODES = new Set(["relay_not_configured", "relay_401", "relay_501", "relay_unreachable", "4101", "4103"])
const CHECKOUT_HOST = "pay.hubtel.com"

export function isConfigRefusal(o: StartOutcome): boolean {
  if (o.kind !== "refused") return false
  return CONFIG_CODES.has(o.code) || o.upstreamStatus === 401 || o.upstreamStatus === 403
}

function isHubtelCheckoutUrl(v: unknown): v is string {
  if (typeof v !== "string") return false
  try {
    const u = new URL(v)
    return u.protocol === "https:" && u.host === CHECKOUT_HOST && !u.username && !u.password
  } catch { return false }
}
const REF_RE = /^[0-9a-f]{32}$/
/** Longer than the relay's own 8s upstream timeout, so the relay normally answers first. */
const RELAY_TIMEOUT_MS = 15_000

const msg = (v: unknown): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null) ?? ""
  return s.slice(0, 200)
}

/** Pure. Implements the start-response classification table. Throws on a relay validation 400. */
export function classifyStart(reply: RelayReply, route: StartRoute): StartOutcome {
  if (reply.kind === "not_configured") return { kind: "refused", code: "relay_not_configured", message: "relay not configured" }
  if (reply.kind === "transport_error") {
    // Failing to reach the relay at all (DNS, connect, TLS) means Hubtel cannot have it.
    if (failedBeforeSend(reply.error)) return { kind: "refused", code: "relay_unreachable", message: msg(String((reply.error as any)?.message ?? reply.error)) }
    return { kind: "unknown", code: "relay_transport", message: msg(String((reply.error as any)?.message ?? reply.error)) }
  }

  const { httpStatus, json } = reply
  const j: any = json && typeof json === "object" && !Array.isArray(json) ? json : null
  // The relay's own replies, all produced before anything is sent to Hubtel.
  if (httpStatus === 400) throw new HubtelPayInputError(`relay rejected ${route} input: ${msg(j?.error ?? json)}`)
  if (httpStatus === 401) return { kind: "refused", code: "relay_401", message: msg(j?.error ?? json) }
  if (httpStatus === 501) return { kind: "refused", code: "relay_501", message: msg(j?.error ?? json) }
  if (httpStatus !== 200) return { kind: "unknown", code: `relay_${httpStatus}`, message: msg(json) }

  if (!j || typeof j.sent !== "boolean" || typeof j.upstreamStatus !== "number") {
    return { kind: "unknown", code: "malformed_reply", message: msg(json) }
  }
  const up: number = j.upstreamStatus
  if (j.sent === false) {
    if (up === 0) return { kind: "refused", code: "not_sent", message: msg(j.body) }
    return { kind: "unknown", code: "malformed_reply", message: `sent:false with upstreamStatus ${up}` }
  }
  if (up === 0) return { kind: "unknown", code: "no_response", message: msg(j.body) }

  const body: any = j.body && typeof j.body === "object" && !Array.isArray(j.body) ? j.body : null
  const rawCode = route === "receive" ? body?.ResponseCode : body?.responseCode
  const code = typeof rawCode === "string" ? rawCode : null
  const message = msg(body?.Message ?? body?.message ?? body?.status ?? j.body)

  if (REFUSED_HTTP.has(up)) {
    if (code && LIVE_CODES.has(code)) return { kind: "unknown", code, message: `HTTP ${up} contradicted by code ${code}`, upstreamStatus: up }
    return { kind: "refused", code: code ?? `http_${up}`, message, upstreamStatus: up }
  }
  if (up < 200 || up >= 300) return { kind: "unknown", code: code ?? `http_${up}`, message, upstreamStatus: up }
  if (!code) return { kind: "unknown", code: "malformed_reply", message }
  if (REFUSED_CODES.has(code)) return { kind: "refused", code, message }

  if (route === "receive" && code === "0001") {
    const tx = body?.Data?.TransactionId
    return typeof tx === "string" && tx ? { kind: "accepted", hubtelTransactionId: tx } : { kind: "accepted" }
  }
  if (route === "checkout" && code === "0000") {
    const url = body?.data?.checkoutUrl
    if (isHubtelCheckoutUrl(url)) return { kind: "accepted", checkoutUrl: url }
    return { kind: "unknown", code, message: `0000 without an https://${CHECKOUT_HOST} checkoutUrl` }
  }
  return { kind: "unknown", code, message }
}

function assertAmount(amount: unknown): asserts amount is number {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) / 100 !== amount) {
    throw new HubtelPayInputError(`amount must be a positive number with at most 2 decimals, got ${String(amount)}`)
  }
}

/** GH₵ (exact 2-dp) → pesewas. */
export function toPesewas(ghs: number): number {
  return Math.round(ghs * 100)
}

async function callRelay(path: "/receive" | "/checkout", payload: Record<string, unknown>, deps: ClientDeps): Promise<RelayReply> {
  const env = deps.env ?? process.env
  const url = env.HUBTEL_RELAY_URL
  const secret = env.HUBTEL_RELAY_SECRET
  if (!url || !secret) return { kind: "not_configured" }
  const doFetch = deps.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(`${url.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    })
  } catch (error) {
    return { kind: "transport_error", error }
  }
  // An unreadable body after a response is malformed (→ unknown), never a transport failure.
  const json = await res.json().catch(() => null)
  return { kind: "reply", httpStatus: res.status, json }
}

export async function receiveMoney(
  p: { reference: string; msisdn: string; channel: string; amount: number; description: string; callbackUrl: string },
  deps: ClientDeps = {},
): Promise<StartOutcome> {
  assertAmount(p.amount)
  const payload = { reference: p.reference, msisdn: p.msisdn, channel: p.channel, amount: p.amount, description: p.description, callbackUrl: p.callbackUrl }
  return classifyStart(await callRelay("/receive", payload, deps), "receive")
}

export async function initiateCheckout(
  p: { reference: string; amount: number; description: string; callbackUrl: string; returnUrl: string; cancellationUrl: string },
  deps: ClientDeps = {},
): Promise<StartOutcome> {
  assertAmount(p.amount)
  const payload = { reference: p.reference, amount: p.amount, description: p.description, callbackUrl: p.callbackUrl, returnUrl: p.returnUrl, cancellationUrl: p.cancellationUrl }
  return classifyStart(await callRelay("/checkout", payload, deps), "checkout")
}

export interface PaymentStatus {
  kind: "paid" | "unpaid" | "refunded" | "not_found" | "error"
  amountPesewas?: number
  chargesPesewas?: number
  paymentMethod?: string
  transactionId?: string
  raw: unknown
}

const isRelayOwnError = (body: unknown): boolean =>
  !!body && typeof body === "object" && !Array.isArray(body) &&
  Object.keys(body).length === 1 && typeof (body as any).error === "string"

/**
 * Wraps the relay /status check. Never throws. Only "paid" may lead to fulfilment (the caller still checks amount/method).
 * A 2xx is only believed when Hubtel's own responseCode is "0000" and data.clientReference is the reference we asked
 * about; anything else (a success-shaped reply about another transaction, or no proof either way) is kind "error".
 */
export async function checkPaymentStatus(
  reference: string,
  deps: { checkStatus?: (ref: string) => Promise<StatusCheckResult> } = {},
): Promise<PaymentStatus> {
  const check = deps.checkStatus ?? checkTransactionStatus
  let res: StatusCheckResult
  try { res = await check(reference) } catch (e: any) {
    return { kind: "error", raw: { error: String(e?.message ?? e) } }
  }
  if (!res.ok) {
    // Hubtel's 404 = "payment record not found". The relay's own unknown-route 404 ({error}) is not that.
    if (res.upstreamStatus === 404 && !isRelayOwnError(res.body)) return { kind: "not_found", raw: res }
    return { kind: "error", raw: res }
  }
  const d: any = res.data ?? {}
  if (d.clientReference !== reference || (res.body as any)?.responseCode !== "0000") return { kind: "error", raw: res }
  const extra = {
    ...(typeof d.charges === "number" && Number.isFinite(d.charges) ? { chargesPesewas: toPesewas(d.charges) } : {}),
    ...(typeof d.paymentMethod === "string" ? { paymentMethod: d.paymentMethod } : {}),
    ...(typeof d.transactionId === "string" ? { transactionId: d.transactionId } : {}),
  }
  const amount = typeof d.amount === "number" && Number.isFinite(d.amount) ? { amountPesewas: toPesewas(d.amount) } : {}
  switch (res.status) {
    case "Paid":
      if (!("amountPesewas" in amount)) return { kind: "error", raw: res }
      return { kind: "paid", ...amount, ...extra, raw: res }
    case "Unpaid": return { kind: "unpaid", ...amount, ...extra, raw: res }
    case "Refunded": return { kind: "refunded", ...amount, ...extra, raw: res }
    default: return { kind: "error", raw: res }
  }
}

/** Signed callback URL for one payment: `${NEXT_PUBLIC_APP_URL}/api/webhooks/hubtel-payments?ref=…&sig=…`. */
export function hubtelCallbackUrl(reference: string, env: Env = process.env): string {
  if (!REF_RE.test(reference)) throw new HubtelPayInputError("invalid Hubtel reference")
  const secret = env.HUBTEL_PAYMENTS_CALLBACK_SECRET
  if (!secret || secret.length < 32) throw new Error("HUBTEL_PAYMENTS_CALLBACK_SECRET is not configured (must be at least 32 chars)")
  const app = env.NEXT_PUBLIC_APP_URL
  let base: URL
  try { base = new URL(app ?? "") } catch { throw new Error("NEXT_PUBLIC_APP_URL is not configured") }
  if (base.protocol !== "https:") throw new Error("NEXT_PUBLIC_APP_URL must be https")
  const u = new URL("/api/webhooks/hubtel-payments", base)
  u.searchParams.set("ref", reference)
  u.searchParams.set("sig", signRef(reference, secret))
  return u.toString()
}
