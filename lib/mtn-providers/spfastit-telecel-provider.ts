/**
 * SPFastIT Telecel Provider — Telecel only.
 *
 * A separate account/API from the existing AT-iShare-only SPFastIT provider
 * (spfastit-provider.ts, console.spfastit.com, form-encoded). This one uses
 * SPFastIT's newer JSON API at spfastit.com/wp-json/custom-api/v1, which
 * also supports MTN — out of scope here; MTN already has 10 providers.
 *
 * size_mb = size_gb * 1000 here (confirmed from the doc's own Telecel size
 * list), unlike the 1024 convention most of this codebase uses elsewhere.
 */
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat, validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"

const BASE_URL = process.env.SPFASTIT_TELECEL_BASE_URL ?? "https://spfastit.com/wp-json/custom-api/v1"
const REQUEST_TIMEOUT = 30_000

function apiKey(): string {
  return process.env.SPFASTIT_TELECEL_API_KEY ?? ""
}

async function apiCall(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey(), ...body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  })
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Maps SPFastIT's order_status values to this app's canonical status set.
 * The doc only gives two concrete values ("initiated" right after order
 * placement, "completed" in the status-check example) — no exhaustive list.
 * Anything that reads as a rejection maps to failed; everything else is
 * still in flight. Flag for a live re-test if a real terminal status ever
 * doesn't match this.
 */
export function mapSpfastitTelecelStatus(raw: string): "pending" | "processing" | "completed" | "failed" {
  const s = (raw ?? "").toLowerCase().trim()
  if (s === "completed") return "completed"
  if (/fail|cancel|reject|block/.test(s)) return "failed"
  return "processing"
}

/** GB → MB at this API's confirmed Telecel rate (1000MB = 1GB). */
export function gbToMb(gb: number): number {
  return Math.round(gb * 1000)
}

// ── Provider class ───────────────────────────────────────────────────────────

export class SPFastITTelecelProvider implements MTNProvider {
  name = "spfastit_telecel"

  async createOrder(request: MTNOrderRequest): Promise<MTNOrderResponse> {
    if (!isValidPhoneFormat(request.recipient_phone)) {
      return { success: false, message: `Invalid phone: ${request.recipient_phone}`, error_type: "VALIDATION" }
    }
    if (!validatePhoneNetworkMatch(request.recipient_phone, request.network)) {
      return { success: false, message: `Phone does not match ${request.network}`, error_type: "VALIDATION" }
    }

    const phone = normalizePhoneNumber(request.recipient_phone)
    const webhookSecret = process.env.SPFASTIT_TELECEL_WEBHOOK_SECRET
    const webhookBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://www.datagod.store"
    const webhookUrl = webhookSecret
      ? `${webhookBase}/api/webhooks/mtn/spfastit-telecel?token=${webhookSecret}`
      : undefined

    let res: Response
    try {
      res = await apiCall("/place-order", {
        phone,
        size_mb: gbToMb(request.size_gb),
        network: "telecel",
        ...(request.client_ref ? { reference: request.client_ref } : {}),
        ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
      })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error", error_type: "NETWORK_ERROR" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)`, error_type: "API_ERROR" }
    }

    if (json.status !== "success") {
      return { success: false, message: json.message ?? `API error (status ${res.status})`, error_type: "API_ERROR" }
    }

    return { success: true, order_id: json.order_id, message: json.message ?? "Order placed" }
  }

  async checkOrderStatus(transactionId: string | number): Promise<MTNOrderStatusResponse> {
    const id = String(transactionId)
    if (id.startsWith("FAILED_INIT_")) {
      return { success: true, status: "failed", message: "Order was never submitted to SPFastIT (local failure)" }
    }

    let res: Response
    try {
      res = await apiCall("/status", { order_id: transactionId })
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
      status: mapSpfastitTelecelStatus(json.order_status),
      message: json.status_label ?? json.message ?? "Status retrieved",
      order: json,
    }
  }

  async checkBalance(): Promise<number | null> {
    try {
      const res = await apiCall("/balance", {})
      if (!res.ok) return null
      const json = await res.json()
      if (json.status !== "success") return null
      return typeof json.balance === "number" ? json.balance : null
    } catch {
      return null
    }
  }
}

export default SPFastITTelecelProvider
