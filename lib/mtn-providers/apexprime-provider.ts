import crypto from "crypto"
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat, validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"
import { supabaseAdmin as supabase } from "@/lib/supabase"

const BASE_URL = process.env.APEXPRIME_BASE_URL ?? "https://apexprime.club/api/v1"
const TIMEOUT = 30_000

function apiKey(): string {
  return process.env.APEXPRIME_API_KEY ?? ""
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT),
  })
}

/** admin_settings keys for the per-network GroupShare/Store fulfillment-path toggle. */
export const FULFILLMENT_PATH_KEYS: Record<"MTN" | "Telecel" | "AirtelTigo", string> = {
  MTN: "apexprime_mtn_fulfillment_path",
  Telecel: "apexprime_telecel_fulfillment_path",
  AirtelTigo: "apexprime_ishare_fulfillment_path",
}

async function getFulfillmentPath(network: "MTN" | "Telecel" | "AirtelTigo"): Promise<"groupshare" | "store"> {
  try {
    const { data } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", FULFILLMENT_PATH_KEYS[network])
      .maybeSingle()
    return data?.value?.path === "store" ? "store" : "groupshare"
  } catch {
    return "groupshare"
  }
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** Map our internal network name to Apex Prime's own network string. */
export function mapNetworkToApex(network: "MTN" | "Telecel" | "AirtelTigo"): "MTN" | "Telecel" | "Ishare" {
  if (network === "Telecel") return "Telecel"
  if (network === "AirtelTigo") return "Ishare"
  return "MTN"
}

/** Map Apex Prime's status string to our canonical 4-state set. */
export function normalizeApexStatus(raw: string): "pending" | "processing" | "completed" | "failed" {
  const s = (raw ?? "").toLowerCase().trim()
  if (s === "completed" || s === "success" || s === "successful") return "completed"
  if (s.includes("fail") || s.includes("reject") || s.includes("cancel") || s.includes("refund")) return "failed"
  if (s === "pending" || s === "waiting") return "pending"
  return "processing"
}

/**
 * Find the store product_id matching a network + exact GB amount from
 * GET /store-products' data_products list. Data products only — digital
 * products (no network/gb_amount fields) are never matched. No nearest-size
 * guessing: an exact match or nothing.
 */
export function findMatchingProduct(
  products: Array<{ product_id: string | number; type?: string; network?: string; gb_amount?: number }>,
  network: string,
  sizeGb: number
): string | number | undefined {
  const match = products.find(p =>
    p.type === "data" &&
    typeof p.network === "string" && p.network.toLowerCase() === network.toLowerCase() &&
    typeof p.gb_amount === "number" && p.gb_amount === sizeGb
  )
  return match?.product_id
}

/**
 * Parse a stored tracking id of the form "bundle:<id>" or "store:<id>" back
 * into its fulfillment-path kind and raw id. Required because Apex Prime's
 * /status endpoint needs to know which `type` to query, and checkOrderStatus()
 * only ever receives the stored id string — no other context is available.
 */
export function parseTrackingId(id: string): { kind: "bundle" | "store"; rawId: string } | null {
  const idx = id.indexOf(":")
  if (idx === -1) return null
  const kind = id.slice(0, idx)
  const rawId = id.slice(idx + 1)
  if ((kind === "bundle" || kind === "store") && rawId.length > 0) return { kind, rawId }
  return null
}

// ── Provider class ───────────────────────────────────────────────────────────

export class ApexPrimeProvider implements MTNProvider {
  name = "apexprime"

  async createOrder(request: MTNOrderRequest): Promise<MTNOrderResponse> {
    if (!isValidPhoneFormat(request.recipient_phone)) {
      return { success: false, message: `Invalid phone: ${request.recipient_phone}`, error_type: "VALIDATION" }
    }
    if (!validatePhoneNetworkMatch(request.recipient_phone, request.network)) {
      return { success: false, message: `Phone does not match ${request.network}`, error_type: "VALIDATION" }
    }

    const phone = normalizePhoneNumber(request.recipient_phone)
    const reference = request.client_ref ?? crypto.randomUUID()
    const apexNetwork = mapNetworkToApex(request.network)
    const path = await getFulfillmentPath(request.network)

    return path === "store"
      ? this.createViaStore(phone, apexNetwork, request.size_gb, reference)
      : this.createViaGroupShare(phone, apexNetwork, request.size_gb, reference)
  }

  private async createViaGroupShare(phone: string, apexNetwork: string, sizeGb: number, reference: string): Promise<MTNOrderResponse> {
    let res: Response
    try {
      res = await apiFetch("/send-bundle", {
        method: "POST",
        body: JSON.stringify({ network: apexNetwork, recipient: phone, amount: sizeGb, reference }),
      })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error", error_type: "NETWORK_ERROR" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)`, error_type: "API_ERROR" }
    }

    if (!res.ok || json.success !== true) {
      return { success: false, message: json?.message ?? `API error ${res.status}`, error_type: "API_ERROR" }
    }

    return { success: true, order_id: `bundle:${json.order_id}`, message: json.message ?? "Bundle order initiated" }
  }

  private async createViaStore(phone: string, apexNetwork: string, sizeGb: number, reference: string): Promise<MTNOrderResponse> {
    let productsRes: Response
    try {
      productsRes = await apiFetch("/store-products", { method: "GET" })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error", error_type: "NETWORK_ERROR" }
    }

    let productsJson: any
    try { productsJson = await productsRes.json() } catch {
      return { success: false, message: `HTTP ${productsRes.status} (non-JSON response)`, error_type: "API_ERROR" }
    }

    if (!productsRes.ok || productsJson.success !== true) {
      return { success: false, message: productsJson?.message ?? `Store products API error ${productsRes.status}`, error_type: "API_ERROR" }
    }

    const dataProducts: any[] = productsJson.data_products ?? []
    const productId = findMatchingProduct(dataProducts, apexNetwork, sizeGb)
    if (productId === undefined) {
      return { success: false, message: `No matching Apex Prime store product for ${apexNetwork} ${sizeGb}GB`, error_type: "VALIDATION" }
    }

    let res: Response
    try {
      res = await apiFetch("/store-order", {
        method: "POST",
        body: JSON.stringify({ product_id: productId, recipient: phone, reference }),
      })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error", error_type: "NETWORK_ERROR" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)`, error_type: "API_ERROR" }
    }

    if (!res.ok || json.success !== true) {
      return { success: false, message: json?.message ?? `API error ${res.status}`, error_type: "API_ERROR" }
    }

    // Store orders never receive an order_id from Apex Prime — our own
    // reference (already a UUID) is the only stable identifier available,
    // which is also what /status expects for type: "store".
    return { success: true, order_id: `store:${reference}`, message: json.message ?? "Store order placed" }
  }

  async checkOrderStatus(orderId: string | number): Promise<MTNOrderStatusResponse> {
    const id = String(orderId)

    if (id.startsWith("FAILED_INIT_")) {
      return { success: true, status: "failed", message: "Order was never submitted to Apex Prime (local failure)" }
    }

    const parsed = parseTrackingId(id)
    if (!parsed) {
      return { success: false, message: `Unrecognized Apex Prime tracking id format: ${id}` }
    }

    let res: Response
    try {
      res = await apiFetch("/status", {
        method: "POST",
        body: JSON.stringify({ type: parsed.kind, order_id: parsed.rawId }),
      })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)` }
    }

    if (!res.ok || json.success !== true) {
      return { success: false, message: json?.message ?? `API error ${res.status}` }
    }

    return { success: true, status: normalizeApexStatus(json.status), message: json.message ?? "Status retrieved", order: json }
  }

  async checkBalance(): Promise<number | null> {
    try {
      const res = await apiFetch("/wallet", { method: "POST" })
      if (!res.ok) return null
      const json = await res.json()
      const raw = json?.balances?.Main_Wallet?.amount
      return typeof raw === "number" ? raw : null
    } catch {
      return null
    }
  }

  // ── Admin / auxiliary methods ──────────────────────────────────────────────
  // Not part of MTNProvider — used by the admin API route (Task 6).

  async getWalletSummary(): Promise<any> {
    const res = await apiFetch("/wallet", { method: "POST" })
    return res.ok ? res.json() : { error: `HTTP ${res.status}` }
  }

  async getTransactions(): Promise<any> {
    const res = await apiFetch("/transactions", { method: "POST" })
    return res.ok ? res.json() : { error: `HTTP ${res.status}` }
  }

  async verifyNumber(phone: string, network: string = "MTN"): Promise<any> {
    const res = await apiFetch("/verify-number", {
      method: "POST",
      body: JSON.stringify({ phone_number: phone, network }),
    })
    return res.json()
  }
}

export default ApexPrimeProvider
