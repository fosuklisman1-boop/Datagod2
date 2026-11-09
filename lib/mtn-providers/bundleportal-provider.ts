import crypto from "crypto"
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat, validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"
import { supabaseAdmin as supabase } from "@/lib/supabase"

const BASE_URL = process.env.BUNDLEPORTAL_BASE_URL ?? "https://api.bundleportal.com/v2"
const TIMEOUT = 30_000

function apiKey(): string {
  return process.env.BUNDLEPORTAL_API_KEY ?? ""
}

async function apiCall(body: Record<string, unknown>): Promise<Response> {
  return fetch(BASE_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  })
}

/** admin_settings key for the admin-selected active MTN route. */
export const MTN_ROUTE_KEY = "bundleportal_mtn_route"

export async function getActiveMtnRoute(): Promise<"mtn" | "mtn_2" | "mtn_3"> {
  try {
    const { data } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", MTN_ROUTE_KEY)
      .maybeSingle()
    const route = data?.value?.route
    return route === "mtn_2" || route === "mtn_3" ? route : "mtn"
  } catch {
    return "mtn"
  }
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Map our internal network + BigTime flag + configured MTN route to Bundle
 * Portal's own `network` value.
 *
 * BigTime is sent as the literal "bigtime" (admin decision 2026-10-27).
 * History: v2 previously hard-rejected it ("Network must be one of: mtn,
 * mtn_1, mtn_2, mtn_3, telecel, ishare, airteltigo") and BigTime went out as
 * "ishare"; a BigTime order sent as "airteltigo" on 2026-09-26 landed as
 * regular iShare, which is why regular AT stays "airteltigo".
 */
export function mapNetworkToBundlePortal(
  network: "MTN" | "Telecel" | "AirtelTigo",
  isBigTime: boolean | undefined,
  mtnRoute: "mtn" | "mtn_2" | "mtn_3"
): string {
  if (network === "MTN") return mtnRoute
  if (network === "Telecel") return "telecel"
  return isBigTime ? "bigtime" : "airteltigo"
}

/** Maps Bundle Portal's order status values to this app's canonical status set. */
export function mapBundlePortalStatus(raw: string): "pending" | "processing" | "completed" | "failed" {
  const s = (raw ?? "").toLowerCase().trim()
  if (s === "completed") return "completed"
  if (s === "failed") return "failed"
  // "processing" and "cached" (accepted, queued for manual delivery) are both
  // still in flight — cached is a real paid order, not a rejection.
  return "processing"
}

/** True for a documented retry-later business rejection code (not a hard failure). */
export function isRetryableErrorCode(code: string | undefined): boolean {
  return code === "pending_order" || code === "network_locked" || code === "rate_limit" || code === "read_rate_limited" || code === "server_error" || code === "order_capacity_busy" || code === "balance_changed"
}

/**
 * Extract Bundle Portal's documented 429 retry-after signal. Per their docs,
 * a 429 always carries both a `Retry-After` header and a `retry_after`
 * field in the JSON body — the header is the standard HTTP mechanism, so it
 * wins if both are present; the body field is a fallback for a caller that
 * only has the parsed JSON (no access to response headers).
 */
export function extractRetryAfterSeconds(headerValue: string | null, jsonRetryAfter: unknown): number | null {
  if (headerValue != null) {
    const fromHeader = Number(headerValue)
    if (!Number.isNaN(fromHeader)) return fromHeader
  }
  return typeof jsonRetryAfter === "number" ? jsonRetryAfter : null
}

/** Appends a "(retry after Ns)" suffix to a message when a 429 retry-after value is known. */
function withRetryAfterSuffix(message: string, retryAfterSeconds: number | null): string {
  return retryAfterSeconds != null ? `${message} (retry after ${retryAfterSeconds}s)` : message
}

/** Attempt 0 is the order's own reference; later attempts get a stable UUID derived from it. */
export function attemptReference(ref: string, attempt: number): string {
  if (attempt === 0) return ref
  const h = crypto.createHash("sha256").update(`${ref}:${attempt}`).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const DEAD_ATTEMPT_STATUSES = new Set(["failed", "reversed"])
const MAX_ATTEMPTS = 10

/**
 * Pick the reference for this send. Bundle Portal answers a reused order_id
 * with the original order (duplicate: true) and mtn_order_id is UNIQUE, so
 * re-sending a failed or reversed order under its old reference delivers
 * nothing and leaves it stuck in processing. A dead attempt moves to the next
 * derived reference; a live one keeps its reference so duplicates are still
 * deduped. Derived, not random, so a network retry can't place a second order.
 * Returns null when the history can't be read or attempts are exhausted.
 */
async function resolveOrderReference(ref: string): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = attemptReference(ref, attempt)
    const { data, error } = await supabase
      .from("mtn_fulfillment_tracking")
      .select("status")
      .eq("mtn_order_id", candidate)
      .maybeSingle()
    if (error) return null
    if (!data || !DEAD_ATTEMPT_STATUSES.has(data.status)) return candidate
  }
  return null
}

// ── Provider class ───────────────────────────────────────────────────────────

export class BundlePortalProvider implements MTNProvider {
  name = "bundleportal"

  async createOrder(request: MTNOrderRequest): Promise<MTNOrderResponse> {
    if (!isValidPhoneFormat(request.recipient_phone)) {
      return { success: false, message: `Invalid phone: ${request.recipient_phone}`, error_type: "VALIDATION" }
    }
    if (!validatePhoneNetworkMatch(request.recipient_phone, request.network)) {
      return { success: false, message: `Phone does not match ${request.network}`, error_type: "VALIDATION" }
    }

    const phone = normalizePhoneNumber(request.recipient_phone)
    // Always sent, even though the docs mark it optional — it's the sole
    // idempotency key AND the sole status-lookup key for this provider.
    const baseRef = request.client_ref ?? (() => {
      console.warn(
        "[BundlePortal] createOrder called with no client_ref — generating a random UUID. " +
        "Idempotent retry-safety requires a stable reference; a caller-level retry after this could double-charge."
      )
      return crypto.randomUUID()
    })()
    const orderId = await resolveOrderReference(baseRef)
    if (!orderId) {
      return { success: false, message: "Could not determine a safe Bundle Portal reference for this order", error_type: "API_ERROR" }
    }
    const mtnRoute = await getActiveMtnRoute()
    const bpNetwork = mapNetworkToBundlePortal(request.network, request.isBigTime, mtnRoute)

    let res: Response
    try {
      res = await apiCall({
        action: "place_order",
        network: bpNetwork,
        recipient: phone,
        package_size: request.size_gb,
        order_id: orderId,
      })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error", error_type: "NETWORK_ERROR" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)`, error_type: "API_ERROR" }
    }

    if (json.success !== true) {
      const errorType = isRetryableErrorCode(json.code) ? "RETRYABLE" : "API_ERROR"
      const baseMessage = json.message ?? `API error (status ${res.status})`
      const retryAfter = res.status === 429 ? extractRetryAfterSeconds(res.headers.get("retry-after"), json.retry_after) : null
      return { success: false, message: withRetryAfterSuffix(baseMessage, retryAfter), error_type: errorType }
    }

    // json.data.duplicate === true means this order_id was already submitted —
    // Bundle Portal returns the ORIGINAL order rather than creating a second
    // one or charging again. Treated as an ordinary success.
    return { success: true, order_id: orderId, message: json.data?.duplicate ? "Order already placed (recovered retry)" : (json.message ?? "Order placed successfully") }
  }

  async checkOrderStatus(orderId: string | number): Promise<MTNOrderStatusResponse> {
    const id = String(orderId)
    if (id.startsWith("FAILED_INIT_")) {
      return { success: true, status: "failed", message: "Order was never submitted to Bundle Portal (local failure)" }
    }

    // Bundle Portal's v2 API permanently removed status polling — check_status
    // now always returns HTTP 410 { code: "polling_disabled" }, confirmed in
    // their current docs. Short-circuit rather than making a network call
    // that can never succeed; webhooks (app/api/webhooks/mtn/bundleportal/
    // route.ts) are the only channel this provider reports outcomes on now.
    return {
      success: false,
      message: "Bundle Portal v2 has no status polling — order outcomes arrive only via webhook.",
    }
  }

  async checkBalance(): Promise<number | null> {
    try {
      const res = await apiCall({ action: "check_balance" })
      if (!res.ok) return null
      const json = await res.json()
      if (json.success !== true) return null
      const bal = json.data?.wallet_balance
      return typeof bal === "number" ? bal : null
    } catch {
      return null
    }
  }

  // ── Admin / auxiliary — used by the whitelist registry (Task 6) and the
  // admin API route (Task 5). Not part of MTNProvider.

  async verifyNumber(phone: string, network: string): Promise<any> {
    const res = await apiCall({ action: "verify_number", network, recipient: normalizePhoneNumber(phone) })
    if (!res.ok) {
      if (res.status === 429) {
        // Reads (verify_number, get_bundles, check_balance) have their own
        // separate rate-limit allowance from order placement, per the docs.
        let json: any = null
        try { json = await res.json() } catch { /* body may be absent/non-JSON */ }
        const retryAfter = extractRetryAfterSeconds(res.headers.get("retry-after"), json?.retry_after)
        throw new Error(withRetryAfterSuffix("Bundle Portal verify_number read-rate-limited", retryAfter))
      }
      throw new Error(`Bundle Portal verify_number API error ${res.status}`)
    }
    return res.json()
  }

  async setWebhook(webhookUrl: string): Promise<any> {
    const res = await apiCall({ action: "set_webhook", webhook_url: webhookUrl })
    if (!res.ok) throw new Error(`Bundle Portal set_webhook API error ${res.status}`)
    return res.json()
  }
}

export default BundlePortalProvider
