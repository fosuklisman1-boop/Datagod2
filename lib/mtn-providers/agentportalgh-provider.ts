import crypto from "crypto"
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat, validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"
import { supabaseAdmin as supabase } from "@/lib/supabase"

const BASE_URL = process.env.AGENTPORTALGH_BASE_URL ?? "https://api.agentportalgh.com"
const TIMEOUT = 30_000

function apiKey(): string {
  return process.env.AGENTPORTALGH_API_KEY ?? ""
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "X-API-Key": apiKey(), "Content-Type": "application/json", ...(extra ?? {}) }
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers as Record<string, string> ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT),
  })
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** Map AgentPortal item status to our canonical status set. */
export function mapItemStatus(raw: string): "pending" | "processing" | "completed" | "failed" {
  const s = (raw ?? "").toLowerCase().trim()
  if (s === "success") return "completed"
  if (s === "failed") return "failed"
  if (s === "pending") return "pending"
  return "processing"
}

/** Construct the POST /api/queue/add request body. */
export function buildQueuePayload(
  msisdn: string,
  dataGb: number,
  reference: string
): { service: string; items: Array<{ msisdn: string; data_gb: number; reference: string }> } {
  return {
    service: "mtn",
    items: [{ msisdn, data_gb: Math.round(dataGb), reference }],
  }
}

/**
 * Derive a terminal/in-flight status from an order-listing entry returned by
 * GET /api/beneficiaries/orders (confirmed shape per AgentPortalGH docs §7:
 * { group_name, processing_status, uploaded_count, success_count,
 * failure_count, missing_count, created_at, updated_at } — note the order-level
 * status field is "processing_status", NOT "status"). Returns null if the entry
 * doesn't carry enough info to decide (caller should try another source).
 */
export function deriveOrderStatus(order: any): "completed" | "failed" | "processing" | null {
  const success = typeof order?.success_count === "number" ? order.success_count : undefined
  const failure = typeof order?.failure_count === "number" ? order.failure_count : undefined
  if (success === undefined && failure === undefined) return null
  if ((failure ?? 0) > 0 && (success ?? 0) === 0) return "failed"
  if ((success ?? 0) > 0 && (failure ?? 0) === 0) return "completed"
  const processingStatus = order?.processing_status ?? order?.status
  if (processingStatus === "DONE") return (failure ?? 0) > 0 ? "failed" : "completed"
  return "processing"
}

// ── Provider class ───────────────────────────────────────────────────────────

export class AgentPortalGHProvider implements MTNProvider {
  name = "agentportalgh"

  async createOrder(request: MTNOrderRequest): Promise<MTNOrderResponse> {
    if (!isValidPhoneFormat(request.recipient_phone)) {
      return { success: false, message: `Invalid phone: ${request.recipient_phone}`, error_type: "VALIDATION" }
    }
    if (!validatePhoneNetworkMatch(request.recipient_phone, request.network)) {
      return { success: false, message: `Phone does not match ${request.network}`, error_type: "VALIDATION" }
    }

    const phone = normalizePhoneNumber(request.recipient_phone)
    const reference = request.client_ref ?? crypto.randomUUID()

    let res: Response
    try {
      res = await apiFetch("/api/queue/add", {
        method: "POST",
        body: JSON.stringify(buildQueuePayload(phone, request.size_gb, reference)),
      })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error", error_type: "NETWORK_ERROR" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)`, error_type: "API_ERROR" }
    }

    if (res.status === 402) {
      // Confirmed shape: { "error": "insufficient wallet balance: need GHS X, balance GHS Y" }
      return { success: false, message: json?.error ?? "Insufficient balance", error_type: "INSUFFICIENT_BALANCE" }
    }

    if (!res.ok) {
      // Confirmed error shape is { "error": "message" } — "message" is never the key.
      return { success: false, message: json?.error ?? json?.message ?? `API error ${res.status}`, error_type: "API_ERROR" }
    }

    // added === 0 means every item was rejected (whitelist block or validation)
    if (json.added === 0) {
      const reason = (json.rejected as any[])?.[0]?.reason ?? "Order rejected by provider"
      return { success: false, message: reason, error_type: "WHITELIST_BLOCKED", order_id: reference }
    }

    return { success: true, order_id: reference, message: "Order queued" }
  }

  async checkOrderStatus(orderId: string | number): Promise<MTNOrderStatusResponse> {
    const id = String(orderId)
    const orderIdOf = (o: any): string | undefined => o?.order_id ?? o?.id

    // The queue's own status (pending/processing/done/failed, §6) is AgentPortalGH's
    // internal processing pipeline — not the real delivery outcome. Retriable
    // failures are auto-retried up to 3 times (§8), so even a "failed" queue item
    // isn't necessarily final. The order listing's success_count/failure_count is
    // the authoritative, post-completion delivery status — that's the only thing
    // allowed to set a terminal status here. Look up our own tracking row for the
    // recipient phone + creation date, so we can search AgentPortalGH's order
    // listing precisely instead of guessing at pagination/sort order on an
    // unscoped query. Per their docs (§7):
    // GET /api/beneficiaries/orders?filter=&search=&date= — search is a numeric
    // MSISDN substring match or a group-name match; date scopes to a single day.
    let phone: string | undefined
    let createdDate: string | undefined
    try {
      const { data: tracking } = await supabase
        .from("mtn_fulfillment_tracking")
        .select("recipient_phone, created_at")
        .eq("mtn_order_id", id)
        .maybeSingle()
      phone = tracking?.recipient_phone ?? undefined
      createdDate = tracking?.created_at ? String(tracking.created_at).slice(0, 10) : undefined
    } catch (err) {
      console.warn("[AgentPortalGH] Could not look up tracking row for status check:", err)
    }

    const today = new Date().toISOString().slice(0, 10)
    // Try the order's own creation date first (most precise), then today (covers
    // clock/timezone drift), then an unscoped search as a last resort.
    const dateCandidates = Array.from(new Set([createdDate, today, undefined]))

    for (const date of dateCandidates) {
      try {
        const params = new URLSearchParams()
        if (phone) params.set("search", phone)
        if (date) params.set("date", date)
        const qs = params.toString()
        const ordersRes = await apiFetch(`/api/beneficiaries/orders${qs ? `?${qs}` : ""}`)
        const ordersBody = await ordersRes.text()
        if (!ordersRes.ok) {
          console.warn(`[AgentPortalGH] Order search (date=${date ?? "none"}) HTTP ${ordersRes.status}: ${ordersBody.slice(0, 300)}`)
          continue
        }

        const ordersData = JSON.parse(ordersBody)
        const orders: any[] = ordersData.data ?? ordersData.orders ?? (Array.isArray(ordersData) ? ordersData : [])
        // Prefer an explicit order_id/id match; if the field isn't present on this
        // endpoint's response (unconfirmed in the docs' abbreviated example) but
        // search+date narrowed the result to exactly one order, take it.
        const order = orders.find(o => orderIdOf(o) === id) ?? (orders.length === 1 ? orders[0] : undefined)
        if (!order) {
          console.warn(`[AgentPortalGH] Order ${id} not found among ${orders.length} result(s) for date=${date ?? "none"}, search=${phone ?? "none"}`)
          continue
        }

        const derived = deriveOrderStatus(order)
        if (derived) {
          return { success: true, status: derived, message: order.processing_status ?? order.status ?? "Status retrieved", order }
        }

        // Listing didn't carry counts — fall back to inspecting items directly.
        const itemsRes = await apiFetch(`/api/beneficiaries/orders/${orderIdOf(order)}/items`)
        if (itemsRes.ok) {
          const itemsData = await itemsRes.json()
          const items: any[] = itemsData.data ?? itemsData.items ?? (Array.isArray(itemsData) ? itemsData : [])
          const item = items[0]
          if (item) {
            return {
              success: true,
              status: mapItemStatus(item.status),
              message: item.failed_reason ?? item.status ?? "Status retrieved",
              order: item,
            }
          }
        }
      } catch (err) {
        console.warn(`[AgentPortalGH] Order search (date=${date ?? "none"}) threw:`, err)
      }
    }

    // Not found under any search — treat as still in flight
    return { success: true, status: "processing", message: "Order in flight (not yet found in order listing)" }
  }

  async checkBalance(): Promise<number | null> {
    try {
      const res = await apiFetch("/api/wallet")
      if (!res.ok) return null
      const json = await res.json()
      const raw = json.data?.balance ?? json.balance
      if (typeof raw === "number") return raw
      if (typeof raw === "string") { const n = parseFloat(raw); return isNaN(n) ? null : n }
      return null
    } catch {
      return null
    }
  }

  // ── Admin / auxiliary methods ──────────────────────────────────────────────
  // These are used by the admin API route; they are not part of MTNProvider.

  async getIdentity(): Promise<any> {
    const res = await apiFetch("/api/me")
    return res.ok ? res.json() : { error: `HTTP ${res.status}` }
  }

  async getWalletSummary(from?: string, to?: string): Promise<any> {
    const params = new URLSearchParams()
    if (from) params.set("from", from)
    if (to) params.set("to", to)
    const qs = params.toString() ? `?${params}` : ""
    const res = await apiFetch(`/api/wallet/summary${qs}`)
    return res.ok ? res.json() : { error: `HTTP ${res.status}` }
  }

  async getTransactions(page = 1, pageSize = 25): Promise<any> {
    const res = await apiFetch(`/api/wallet/transactions?page=${page}&page_size=${pageSize}`)
    return res.ok ? res.json() : { error: `HTTP ${res.status}` }
  }

  async topUp(amount: number, phone: string, network: string): Promise<any> {
    const res = await apiFetch("/api/wallet/topup", {
      method: "POST",
      body: JSON.stringify({ amount, phone_number: phone, network }),
    })
    return res.json()
  }

  async getTopups(page = 1, pageSize = 25): Promise<any> {
    const res = await apiFetch(`/api/wallet/topups?page=${page}&page_size=${pageSize}`)
    return res.ok ? res.json() : { error: `HTTP ${res.status}` }
  }

  async previewOrder(service: string, items: any[]): Promise<any> {
    const res = await apiFetch("/api/queue/preview", {
      method: "POST",
      body: JSON.stringify({ service, items }),
    })
    return res.json()
  }

  async verifyWhitelist(msisdns: string[]): Promise<any> {
    const res = await apiFetch("/api/mtn-whitelist/verify", {
      method: "POST",
      body: JSON.stringify({ msisdns }),
    })
    return res.json()
  }

  async getServices(): Promise<any> {
    const res = await apiFetch("/api/services")
    return res.ok ? res.json() : { error: `HTTP ${res.status}` }
  }

  async getWebhookConfig(): Promise<any> {
    const res = await apiFetch("/api/webhooks/config")
    return res.ok ? res.json() : { error: `HTTP ${res.status}` }
  }

  async setWebhookConfig(url: string, enabled: boolean, regenerateSecret = false): Promise<any> {
    const res = await apiFetch("/api/webhooks/config", {
      method: "PUT",
      body: JSON.stringify({ url, enabled, regenerate_secret: regenerateSecret }),
    })
    return res.json()
  }

  async getWebhookDeliveries(page = 1, pageSize = 50): Promise<any> {
    const res = await apiFetch(`/api/webhooks/deliveries?page=${page}&page_size=${pageSize}`)
    return res.ok ? res.json() : { error: `HTTP ${res.status}` }
  }

  async resendWebhookDelivery(id: string | number): Promise<any> {
    const res = await apiFetch(`/api/webhooks/deliveries/${id}/resend`, { method: "POST" })
    return res.json()
  }

  async getOrders(filter?: string, search?: string, date?: string): Promise<any> {
    const params = new URLSearchParams()
    if (filter) params.set("filter", filter)
    if (search) params.set("search", search)
    if (date) params.set("date", date)
    const qs = params.toString() ? `?${params}` : ""
    const res = await apiFetch(`/api/beneficiaries/orders${qs}`)
    return res.ok ? res.json() : { error: `HTTP ${res.status}` }
  }

  async getOrderItems(orderId: string | number, status?: string): Promise<any> {
    const params = new URLSearchParams()
    if (status) params.set("status", status)
    const qs = params.toString() ? `?${params}` : ""
    const res = await apiFetch(`/api/beneficiaries/orders/${orderId}/items${qs}`)
    return res.ok ? res.json() : { error: `HTTP ${res.status}` }
  }
}

export default AgentPortalGHProvider
