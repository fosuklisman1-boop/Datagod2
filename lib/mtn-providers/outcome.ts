/**
 * "Outcome unknown" handling for provider ORDER-CREATION calls.
 *
 * When the order request has been sent and the reply is unreadable (non-JSON,
 * empty, HTTP 5xx without an explicit provider rejection, or the fetch threw),
 * the provider may well have created the order. Treating that as a plain
 * failure made us resend (duplicate deliveries). Instead the response carries
 * error_type OUTCOME_UNKNOWN: createMTNOrder stops trying providers and callers
 * hold the order for an admin to check the provider's dashboard.
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

const GENERIC_SERVER_ERRORS =
  /^(internal server error|server error|bad gateway|service unavailable|gateway time-?out|something went wrong|error|unexpected error)\.?$/i

function isExplicitRejection(json: any): boolean {
  if (!json || typeof json !== "object") return false
  const msg =
    typeof json.message === "string" ? json.message : typeof json.error === "string" ? json.error : ""
  if (!msg.trim() || GENERIC_SERVER_ERRORS.test(msg.trim())) return false
  return json.success === false || json.status === "error" || json.status === "failed" || typeof json.error === "string"
}

export type ReplyClass =
  | { kind: "unknown" }
  | { kind: "json"; json: any }

/** Pure classifier for an order-request reply. */
export function classifyOrderReply(status: number, bodyText: string): ReplyClass {
  if (!bodyText || !bodyText.trim()) return { kind: "unknown" }
  const json = parseLenient(bodyText)
  if (json === undefined || json === null || typeof json !== "object") return { kind: "unknown" }
  if (status >= 500 && !isExplicitRejection(json)) return { kind: "unknown" }
  return { kind: "json", json }
}

export type OrderRequestResult =
  | { ok: true; res: Response; json: any; text: string }
  | { ok: false; response: MTNOrderResponse }

/**
 * Issue the order-creating request and read its reply. `doFetch` must perform
 * ONLY the order request. A throw from it (network/timeout/abort) is treated as
 * outcome unknown, since the request may have reached the provider.
 */
export async function sendOrderRequest(
  providerLabel: string,
  doFetch: () => Promise<Response>,
  traceId?: string
): Promise<OrderRequestResult> {
  let res: Response
  try {
    res = await doFetch()
  } catch {
    return { ok: false, response: outcomeUnknownResponse(providerLabel, null, traceId) }
  }
  let text = ""
  try {
    text = await res.text()
  } catch {
    return { ok: false, response: outcomeUnknownResponse(providerLabel, res.status, traceId) }
  }
  const c = classifyOrderReply(res.status, text)
  if (c.kind === "unknown") {
    return { ok: false, response: outcomeUnknownResponse(providerLabel, res.status, traceId) }
  }
  return { ok: true, res, json: c.json, text }
}
