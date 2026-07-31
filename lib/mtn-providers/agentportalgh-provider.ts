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
 *
 * success_count/failure_count are ONLY authoritative once processing_status is
 * "DONE" — per docs §8, retriable failures are automatically retried up to 3
 * times before becoming terminal, so a non-zero failure_count could reflect an
 * item mid-retry rather than a final outcome. Reading the counts before the
 * order is DONE risks reporting "failed" on something that's about to succeed.
 */
export function deriveOrderStatus(order: any): "completed" | "failed" | "processing" | null {
  const processingStatus = order?.processing_status ?? order?.status
  const success = typeof order?.success_count === "number" ? order.success_count : undefined
  const failure = typeof order?.failure_count === "number" ? order.failure_count : undefined

  // No counts at all — nothing to derive from; let the caller fall back to
  // fetching items directly.
  if (success === undefined && failure === undefined) return null

  if (processingStatus !== "DONE") {
    // Counts are only authoritative once the order itself is DONE — before that,
    // a non-zero failure_count could reflect an item mid-retry (§8: retriable
    // failures are retried up to 3x before becoming terminal), not a final result.
    return "processing"
  }

  if ((failure ?? 0) > 0 && (success ?? 0) === 0) return "failed"
  if ((success ?? 0) > 0) return "completed"
  // DONE with zero success and zero failure (e.g. every item came back "missing")
  // — nothing was delivered, so treat it as failed rather than looping forever.
  return "failed"
}

/**
 * Fetch every item on an order, following pagination (confirmed live 2026-07-27:
 * a 23-item order returns 46 item records — one "uploaded" + one final
 * success/failed per item — paginated 20/page). Capped at 5 pages (~100 records)
 * as a sanity bound; no real order has approached that.
 */
async function fetchAllOrderItems(orderId: string): Promise<any[]> {
  const all: any[] = []
  for (let page = 1; page <= 5; page++) {
    const res = await apiFetch(`/api/beneficiaries/orders/${orderId}/items?page=${page}`)
    if (!res.ok) break
    const body = await res.json()
    const items: any[] = body.data ?? body.items ?? (Array.isArray(body) ? body : [])
    all.push(...items)
    if (items.length === 0 || all.length >= (body.total ?? all.length)) break
  }
  return all
}

/**
 * Find the most recent final (success/failed) item record for a phone within a
 * batch's item list, optionally narrowed by size (data_mb). A batch's item list
 * mixes an initial "uploaded" record with a later terminal one per item, so this
 * ignores non-terminal statuses and picks the newest terminal record if more
 * than one exists.
 */
function findFinalItemForPhone(items: any[], phone: string, sizeGb?: number): any | undefined {
  const candidates = items.filter(i =>
    i.msisdn === phone &&
    (i.status === "success" || i.status === "failed") &&
    (sizeGb === undefined || typeof i.data_mb !== "number" || i.data_mb === Math.round(sizeGb * 1024))
  )
  if (candidates.length === 0) return undefined
  return candidates.sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())[0]
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

    // This placeholder means order creation itself failed — the order was NEVER
    // submitted to AgentPortalGH. There is no batch it could ever correspond to,
    // so the phone+size fallback below must never run for it: confirmed live
    // 2026-07-27/30, it was matching a FAILED_INIT row to an unrelated real
    // order that happened to share the same phone+size the same day, flipping
    // it to "completed" despite AgentPortalGH never having seen it.
    if (id.startsWith("FAILED_INIT_")) {
      return { success: true, status: "failed", message: "Order was never submitted to AgentPortalGH (local failure)" }
    }

    // The queue's own status (pending/processing/done/failed, §6) is AgentPortalGH's
    // internal processing pipeline — not the real delivery outcome. Retriable
    // failures are auto-retried up to 3 times (§8) — but confirmed live 2026-07-27,
    // each retry round is a BRAND NEW order/batch (group_name suffixed -R1-/-R2-/
    // -R3-), not an update to the original. There is no field linking a retry
    // batch back to the original (recovery_of_order_id is always null in
    // practice). So a phone+date search routinely returns several batches for
    // the same recipient once a retry has happened — the old "only trust exactly
    // one match" heuristic then finds nothing and reports "processing" forever,
    // even when a later batch's items show the real, final outcome. Look up our
    // own tracking row for phone + size + creation date so we can search
    // precisely, then inspect every matching batch's items (newest batch first —
    // later retries are the more authoritative outcome) instead of requiring a
    // single unambiguous order-level match.
    let phone: string | undefined
    let createdDate: string | undefined
    let sizeGb: number | undefined
    let hasAmbiguousSibling = false
    try {
      const { data: tracking } = await supabase
        .from("mtn_fulfillment_tracking")
        .select("id, recipient_phone, created_at, size_gb")
        .eq("mtn_order_id", id)
        .maybeSingle()
      phone = tracking?.recipient_phone ?? undefined
      createdDate = tracking?.created_at ? String(tracking.created_at).slice(0, 10) : undefined
      sizeGb = tracking?.size_gb !== undefined && tracking?.size_gb !== null ? Number(tracking.size_gb) : undefined

      // The phone+size fallback below can't distinguish between two of OUR OWN
      // orders that share the same phone+size+day — confirmed live 2026-07-27/30,
      // it attributed one real order's success to an unrelated sibling order for
      // the same phone+size, flipping the wrong one to "completed". If another
      // tracking row shares this exact (phone, size, day), refuse to guess via
      // the fallback rather than risk a false positive.
      if (tracking && phone && createdDate && sizeGb !== undefined) {
        const dayStart = `${createdDate}T00:00:00.000Z`
        const dayEnd = `${createdDate}T23:59:59.999Z`
        const { count } = await supabase
          .from("mtn_fulfillment_tracking")
          .select("id", { count: "exact", head: true })
          .eq("provider", "agentportalgh")
          .eq("recipient_phone", phone)
          .eq("size_gb", sizeGb)
          .neq("id", tracking.id)
          .gte("created_at", dayStart)
          .lte("created_at", dayEnd)
        hasAmbiguousSibling = (count ?? 0) > 0
      }
    } catch (err) {
      console.warn("[AgentPortalGH] Could not look up tracking row for status check:", err)
    }

    const today = new Date().toISOString().slice(0, 10)
    // Try the order's own creation date first (most precise), then today (covers
    // clock/timezone drift). Deliberately NO unscoped (date=undefined) fallback:
    // confirmed live 2026-07-30, an unscoped search returns a phone's ENTIRE
    // order history on AgentPortalGH's side with no day boundary at all, so a
    // repeat customer's brand-new order would match an old, already-completed
    // order for the same phone+size from days earlier — every day-scoped search
    // (createdDate, today) correctly stays within AgentPortalGH's own per-day
    // "date" filter (confirmed §7: "date scopes to a single day"), so this
    // couldn't happen through those; only the unscoped step could reach back
    // arbitrarily far. The hasAmbiguousSibling guard above only checks OUR OWN
    // table for same-day duplicates and can't protect against this at all —
    // removing the unscoped search is the actual fix, not an addition to it.
    const dateCandidates = Array.from(new Set([createdDate, today].filter((d): d is string => !!d)))

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
        if (orders.length === 0) {
          console.warn(`[AgentPortalGH] Order ${id} not found for date=${date ?? "none"}, search=${phone ?? "none"}`)
          continue
        }

        // An explicit order_id/id match is the fastest, most precise path.
        const exact = orders.find(o => orderIdOf(o) === id)
        if (exact) {
          const derived = deriveOrderStatus(exact)
          if (derived) {
            return { success: true, status: derived, message: exact.processing_status ?? exact.status ?? "Status retrieved", order: exact }
          }
        }

        // Otherwise, scan every matching batch's items, newest first — a later
        // retry round is the more authoritative outcome for this phone. Skipped
        // entirely when a sibling tracking row makes the match ambiguous (see
        // above) — stays "processing" rather than risk guessing wrong.
        if (hasAmbiguousSibling) {
          console.warn(`[AgentPortalGH] Skipping phone+size fallback for ${id} — ambiguous sibling tracking row(s) for ${phone}/${sizeGb}GB on ${date ?? "unscoped"}`)
          continue
        }
        const sorted = [...orders].sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())
        for (const o of sorted) {
          const oid = orderIdOf(o)
          if (!oid || !phone) continue
          const items = await fetchAllOrderItems(oid)
          const match = findFinalItemForPhone(items, phone, sizeGb)
          if (match) {
            return {
              success: true,
              status: mapItemStatus(match.status),
              message: match.failed_reason ?? match.status ?? "Status retrieved",
              order: match,
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
