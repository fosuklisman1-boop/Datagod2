/**
 * "Outcome unknown" handling for provider ORDER-CREATION calls.
 *
 * When the order request has been sent and the reply is unreadable (non-JSON,
 * empty, HTTP 5xx without a recognised provider rejection, or the fetch threw
 * after connecting), the provider may well have created the order. Treating
 * that as a plain failure made us resend (duplicate deliveries). Instead the
 * response carries error_type OUTCOME_UNKNOWN: createMTNOrder stops trying
 * providers and callers hold the order for an admin to check the provider's
 * dashboard.
 *
 * Only for the order-creating request. Never use for catalog/balance/whitelist/
 * verify calls made BEFORE the order request.
 */
import type { MTNOrderResponse } from "./types"

export const OUTCOME_UNKNOWN = "OUTCOME_UNKNOWN"

/** Tracking rows for unknown outcomes use this id prefix (status "abandoned"). */
export const UNKNOWN_TRACKING_PREFIX = "UNKNOWN_"

export function isUnknownTrackingId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(UNKNOWN_TRACKING_PREFIX)
}

export function makeUnknownTrackingId(now: number = Date.now()): string {
  return `${UNKNOWN_TRACKING_PREFIX}${now}`
}

export function outcomeUnknownMessage(providerLabel: string, status: number | null): string {
  const what = status == null ? "returned no response" : `returned an unreadable response (HTTP ${status})`
  return `${providerLabel} ${what} — the order may have been created. Check the ${providerLabel} dashboard before retrying.`
}

export function outcomeUnknownResponse(
  providerLabel: string,
  status: number | null,
  traceId?: string
): MTNOrderResponse {
  return {
    success: false,
    message: outcomeUnknownMessage(providerLabel, status),
    traceId,
    error_type: OUTCOME_UNKNOWN,
  }
}

function parseLenient(text: string): any | undefined {
  try {
    return JSON.parse(text)
  } catch {
    // Some APIs print PHP warnings before the JSON.
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return undefined
    try {
      return JSON.parse(m[0])
    } catch {
      return undefined
    }
  }
}

/**
 * On a 5xx, only a body that carries a RECOGNISED provider rejection counts as
 * an ordinary failure. Anything else (cURL/SQLSTATE/exception text, generic
 * server errors) may be a crash after the order was created, so it is unknown.
 */
const RECOGNISED_REJECTION =
  /insufficient|balance|not approved|not registered|invalid|validation|duplicate|does not match|not enabled|out of stock|disabled|not found|unsupported|not eligible|blacklist|whitelist|blocked/i

function isExplicitRejection(json: any): boolean {
  if (!json || typeof json !== "object") return false
  const msg =
    typeof json.message === "string" ? json.message : typeof json.error === "string" ? json.error : ""
  return !!msg.trim() && RECOGNISED_REJECTION.test(msg)
}

/** Statuses a front door/WAF/auth layer returns without the order app ever seeing the request. */
const NEVER_REACHED_STATUSES = new Set([401, 403, 404, 405, 429])

/** Low-level connection errors that prove the request never reached the provider. */
const NEVER_REACHED_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
])

export function isNeverReachedError(err: unknown): boolean {
  const e = err as any
  const codes = [e?.code, e?.cause?.code].filter((c) => typeof c === "string") as string[]
  return codes.some((c) => NEVER_REACHED_CODES.has(c) || c.startsWith("CERT_") || c.startsWith("ERR_TLS_"))
}

/** Response for a send that threw: ordinary NETWORK_ERROR if it never connected, else outcome unknown. */
export function sendErrorResponse(providerLabel: string, err: unknown, traceId?: string): MTNOrderResponse {
  if (isNeverReachedError(err)) {
    return {
      success: false,
      message: err instanceof Error ? err.message : `${providerLabel} request failed before it was sent`,
      traceId,
      error_type: "NETWORK_ERROR",
    }
  }
  return outcomeUnknownResponse(providerLabel, null, traceId)
}

export type ReplyClass =
  | { kind: "unknown" }
  | { kind: "not_reached" }
  | { kind: "json"; json: any }

/** Ordinary failure for a reply that proves the order app never saw the request. */
export function notReachedResponse(providerLabel: string, status: number, traceId?: string): MTNOrderResponse {
  return { success: false, message: `${providerLabel} HTTP ${status} (non-JSON response)`, traceId, error_type: "API_ERROR" }
}

/** Pure classifier for an order-request reply. */
export function classifyOrderReply(status: number, bodyText: string): ReplyClass {
  const json = bodyText && bodyText.trim() ? parseLenient(bodyText) : undefined
  if (json === undefined || json === null || typeof json !== "object") {
    return NEVER_REACHED_STATUSES.has(status) ? { kind: "not_reached" } : { kind: "unknown" }
  }
  if (status >= 500 && !isExplicitRejection(json)) return { kind: "unknown" }
  return { kind: "json", json }
}

/** The response a provider should return for a non-json classification, or null when it is json. */
export function responseForClass(
  providerLabel: string,
  c: ReplyClass,
  status: number,
  traceId?: string
): MTNOrderResponse | null {
  if (c.kind === "unknown") return outcomeUnknownResponse(providerLabel, status, traceId)
  if (c.kind === "not_reached") return notReachedResponse(providerLabel, status, traceId)
  return null
}

export type OrderRequestResult =
  | { ok: true; res: Response; json: any; text: string }
  | { ok: false; response: MTNOrderResponse }

/**
 * Issue the order-creating request and read its reply. `doFetch` must perform
 * ONLY the order request. A throw is outcome unknown unless it proves the
 * request never connected (DNS, refused, TLS); front-door 401/403/404/405/429
 * non-JSON replies are ordinary failures.
 */
export async function sendOrderRequest(
  providerLabel: string,
  doFetch: () => Promise<Response>,
  traceId?: string
): Promise<OrderRequestResult> {
  let res: Response
  try {
    res = await doFetch()
  } catch (err) {
    return { ok: false, response: sendErrorResponse(providerLabel, err, traceId) }
  }
  let text = ""
  try {
    text = await res.text()
  } catch {
    return { ok: false, response: outcomeUnknownResponse(providerLabel, res.status, traceId) }
  }
  const c = classifyOrderReply(res.status, text)
  const bad = responseForClass(providerLabel, c, res.status, traceId)
  if (bad) return { ok: false, response: bad }
  return { ok: true, res, json: (c as { json: any }).json, text }
}
