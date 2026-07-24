import crypto from "crypto"
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat, validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"

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

    if (res.status === 402) {
      return { success: false, message: "Insufficient balance", error_type: "INSUFFICIENT_BALANCE" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)`, error_type: "API_ERROR" }
    }

    if (!res.ok) {
      return { success: false, message: json?.message ?? `API error ${res.status}`, error_type: "API_ERROR" }
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
    // item-level `reference` is unreliable — confirmed live 2026-07-24 via a real
    // webhook payload where item.reference was null. The order's own order_id (or
    // id, depending on endpoint) IS the client_ref/reference we submitted, so match
    // at the order level, not the item level.
    const orderIdOf = (o: any): string | undefined => o?.order_id ?? o?.id
    const itemRef = (item: any): string | undefined =>
      item?.reference ?? item?.client_reference ?? item?.ref ?? item?.order_reference ?? item?.external_reference

    // Step 1: scan the pending queue — no phone needed
    try {
      const queueRes = await apiFetch("/api/queue?status=pending&page_size=100")
      const queueBody = await queueRes.text()
      if (queueRes.ok) {
        const queueData = JSON.parse(queueBody)
        const groups: any[] = queueData.data ?? queueData.items ?? (Array.isArray(queueData) ? queueData : [])
        const inQueue = groups.some(g =>
          orderIdOf(g) === id || (g.items as any[] ?? []).some((item: any) => itemRef(item) === id)
        )
        if (inQueue) return { success: true, status: "pending", message: "Order is in the pending queue" }
      } else {
        console.warn(`[AgentPortalGH] Queue status check HTTP ${queueRes.status}: ${queueBody.slice(0, 300)}`)
      }
    } catch (err) {
      console.warn("[AgentPortalGH] Queue status check threw:", err)
    }

    // Step 2: scan recent order groups for a matching order_id/id (the reliable
    // identifier — see note above). Deliberately NOT filtered by phone via `search=`
    // — that query param's actual filtering behavior against this API is unverified,
    // so an unfiltered recent-orders scan is more likely to actually find the order
    // than a filter that may silently match nothing. Recent orders are assumed
    // newest-first, so our just-created order should be within the first page.
    try {
      const ordersRes = await apiFetch(`/api/beneficiaries/orders?page_size=100`)
      const ordersBody = await ordersRes.text()
      if (ordersRes.ok) {
        const ordersData = JSON.parse(ordersBody)
        const orders: any[] = ordersData.data ?? ordersData.orders ?? (Array.isArray(ordersData) ? ordersData : [])
        const order = orders.find(o => orderIdOf(o) === id)
        if (order) {
          // The listing itself carries status/success_count/failure_count (same
          // shape as the webhook payload), so we usually don't need a second
          // items-fetch call at all.
          if (typeof order.success_count === "number" || typeof order.failure_count === "number") {
            const status: "completed" | "failed" | "processing" =
              (order.failure_count ?? 0) > 0 && (order.success_count ?? 0) === 0 ? "failed"
                : (order.success_count ?? 0) > 0 && (order.failure_count ?? 0) === 0 ? "completed"
                : order.status === "DONE" ? ((order.failure_count ?? 0) > 0 ? "failed" : "completed")
                : "processing"
            return { success: true, status, message: order.status ?? "Status retrieved", order }
          }
          // Fall back to inspecting items if the listing didn't include counts
          const itemsRes = await apiFetch(`/api/beneficiaries/orders/${order.id ?? order.order_id}/items`)
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
        } else {
          console.warn(`[AgentPortalGH] Order ${id} not found across ${orders.length} recent order group(s)`)
        }
      } else {
        console.warn(`[AgentPortalGH] Order search HTTP ${ordersRes.status}: ${ordersBody.slice(0, 300)}`)
      }
    } catch (err) {
      console.warn("[AgentPortalGH] Order search threw:", err)
    }

    // Not found in pending queue or completed orders — treat as still in flight
    return { success: true, status: "processing", message: "Order in flight (not yet in queue or completed list)" }
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
