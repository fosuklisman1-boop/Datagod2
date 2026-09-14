/**
 * SPFastIT Provider — AT-iShare (AirtelTigo) only.
 *
 * Unlike every other provider in this codebase, SPFastIT's API is
 * form-urlencoded (matches its documented `-d "key=value"` curl examples),
 * not JSON, and authenticates via a flat `api_key` POST field rather than a
 * header.
 *
 * Reference-reuse is safe here, unlike AgentPortalGH/ApexPrime/DataKazina/
 * Bisdel: SPFastIT's own docs guarantee that resubmitting the same
 * client_reference with the same phone+bundle returns the EXISTING
 * transaction (duplicate:true) instead of erroring, and only flags a real
 * conflict when the same reference is paired with a different phone/bundle —
 * which can't happen here since client_ref is always a unique order UUID.
 */
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat, validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"

const BASE_URL = process.env.SPFASTIT_BASE_URL ?? "https://console.spfastit.com"
const REQUEST_TIMEOUT = 30_000

function apiKey(): string {
  return process.env.SPFASTIT_API_KEY ?? ""
}

async function apiFetch(path: string, params: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams({ api_key: apiKey(), ...params })
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  })
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** Maps SPFastIT's order_status values to this app's canonical status set. */
export function mapSpfastitStatus(raw: string): "pending" | "processing" | "completed" | "failed" {
  const s = (raw ?? "").toLowerCase().trim()
  if (s === "completed") return "completed"
  if (s === "failed" || s === "failed_blocked" || s === "billed_failure") return "failed"
  // queued, processing, pending_retry, and any unrecognized value — still in flight
  return "processing"
}

// SPFastIT explicitly documents 1000MB = 1GB ("Your system uses 1000MB = 1GB"),
// NOT the binary 1024 convention every other provider in this codebase uses.
// Independently confirmed by their own check_balance example response:
// wallet_balance_mb: 100000, wallet_balance_gb: 100 → 100000/100 = 1000.
export function gbToBundleMb(sizeGb: number): number {
  return Math.round(sizeGb * 1000)
}

export function mbToGb(mb: number): number {
  return mb / 1000
}

// ── Provider class ───────────────────────────────────────────────────────────

export class SPFastITProvider implements MTNProvider {
  name = "spfastit"

  async createOrder(request: MTNOrderRequest): Promise<MTNOrderResponse> {
    if (!isValidPhoneFormat(request.recipient_phone)) {
      return { success: false, message: `Invalid phone: ${request.recipient_phone}`, error_type: "VALIDATION" }
    }
    if (!validatePhoneNetworkMatch(request.recipient_phone, request.network)) {
      return { success: false, message: `Phone does not match ${request.network}`, error_type: "VALIDATION" }
    }
    const phone = normalizePhoneNumber(request.recipient_phone)
    const bundleMb = gbToBundleMb(request.size_gb)
    const clientReference = request.client_ref

    let res: Response
    try {
      res = await apiFetch("/api/send.php", {
        phone,
        bundle_mb: String(bundleMb),
        ...(clientReference ? { client_reference: clientReference } : {}),
      })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error", error_type: "NETWORK_ERROR" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)`, error_type: "API_ERROR" }
    }

    if (json.status !== "success") {
      // Confirmed shape: { status:"error", message:"This client_reference has already
      // been used for a different phone number or bundle size." } — cannot actually
      // happen given client_reference is always a fresh order UUID, but handled
      // explicitly rather than silently mis-parsed as a generic API_ERROR.
      const isReferenceConflict = typeof json.message === "string" && /already been used for a different/i.test(json.message)
      return {
        success: false,
        message: json.message ?? `API error (status ${res.status})`,
        error_type: isReferenceConflict ? "REFERENCE_CONFLICT" : "API_ERROR",
      }
    }

    // json.duplicate === true means this exact (reference, phone, bundle) was already
    // queued — SPFastIT returns the EXISTING transaction rather than erroring or
    // creating a second one. Treated as an ordinary success: the caller doesn't need
    // to know this was a recovered retry rather than a first attempt.
    return { success: true, order_id: json.transaction_id, message: json.message ?? "Order queued" }
  }

  async checkOrderStatus(transactionId: string | number): Promise<MTNOrderStatusResponse> {
    const id = String(transactionId)
    if (id.startsWith("FAILED_INIT_")) {
      return { success: true, status: "failed", message: "Order was never submitted to SPFastIT (local failure)" }
    }

    let res: Response
    try {
      res = await apiFetch("/api/check_order_status.php", { transaction_id: id })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)` }
    }

    if (json.status !== "success") {
      return { success: false, message: json.message ?? `API error (status ${res.status})` }
    }

    return {
      success: true,
      status: mapSpfastitStatus(json.order_status),
      message: json.response_message ?? json.message ?? "Status retrieved",
      order: json,
    }
  }

  /** Returns available balance in GB (this provider's balance is data volume, not currency). */
  async checkBalance(): Promise<number | null> {
    try {
      const res = await apiFetch("/api/check_balance.php", {})
      if (!res.ok) return null
      const json = await res.json()
      if (json.status !== "success") return null
      const mb = json.available_mb
      return typeof mb === "number" ? mbToGb(mb) : null
    } catch {
      return null
    }
  }
}

export default SPFastITProvider
