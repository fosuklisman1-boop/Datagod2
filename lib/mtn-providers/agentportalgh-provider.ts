import crypto from "crypto"
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat, validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { sendOrderRequest, isUnknownTrackingId, unknownStatusResult } from "./outcome"

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
  reference: string,
  network: "MTN" | "Telecel" | "AirtelTigo"
): { service: string; items: Array<{ msisdn: string; data_gb: number; reference: string }> } {
  const service = network === "Telecel" ? "telecel" : network === "AirtelTigo" ? "airteltigo" : "mtn"
  return {
    service,
    items: [{ msisdn, data_gb: Math.round(dataGb), reference }],
  }
}

/**
 * Classify a per-item rejection reason from POST /api/queue/add's `rejected`
 * array. A duplicate/stale client_ref is NOT a whitelist problem — it's an
 * ordinary, retryable failure (no `held` flag), so mislabeling it
 * "WHITELIST_BLOCKED" would be misleading and, if anything downstream ever
 * keys off error_type, risks it being conflated with a genuine per-item
 * whitelist rejection from AgentPortalGH's own check.
 */
export function classifyRejectionReason(reason: string): "DUPLICATE_REFERENCE" | "WHITELIST_BLOCKED" {
  return /reference.*already.*(been )?used/i.test(reason) ? "DUPLICATE_REFERENCE" : "WHITELIST_BLOCKED"
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
async function fetchAllOrderItems(orderId: string): Promise<{ items: any[]; complete: boolean }> {
  const all: any[] = []
  for (let page = 1; page <= 5; page++) {
    const res = await apiFetch(`/api/beneficiaries/orders/${orderId}/items?page=${page}`)
    // A failed page means the list is partial — callers must not resolve anything from it.
    if (!res.ok) return { items: all, complete: false }
    const body = await res.json()
    const items: any[] = body.data ?? body.items ?? (Array.isArray(body) ? body : [])
    all.push(...items)
    if (items.length === 0 || all.length >= (body.total ?? all.length)) return { items: all, complete: true }
  }
  // Page cap reached before the reported total.
  return { items: all, complete: false }
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

export interface BatchOutcome {
  status: "completed" | "failed"
  externalStatus: string
  failedReason: string | null
  msisdn: string
  /** The terminal row the outcome came from (for callers that need the raw item). */
  item: any
}

function msisdnKey(m: unknown): string {
  return String(m ?? "").replace(/\D/g, "").slice(-9)
}

function sizesCompatible(a: any, b: any): boolean {
  return typeof a?.data_mb !== "number" || typeof b?.data_mb !== "number" || a.data_mb === b.data_mb
}

function createdMs(i: any): number {
  const t = new Date(i?.created_at ?? 0).getTime()
  return Number.isFinite(t) ? t : 0
}

/**
 * AgentPortalGH processes our single-item submissions inside its own group order and
 * never echoes our reference on the final row: an item list holds an "uploaded" row
 * carrying OUR reference plus a separate terminal row (success/failed, reference null)
 * for the same number. Pair them up by msisdn (+ data_mb) and return the outcome per
 * our reference. Never guesses: if several of our references target the same number
 * (and size) in this list and their candidate outcomes are not all the same, none of
 * them gets an entry.
 */
export function resolveBatchOutcomes(items: any[]): Map<string, BatchOutcome> {
  const result = new Map<string, BatchOutcome>()
  const list = Array.isArray(items) ? items : []

  const refOf = (i: any): string => (typeof i?.reference === "string" ? i.reference.trim() : "")
  const isSuperseded = (i: any): boolean => !!(i?.replaced_at || i?.replaced_by_batch_id)
  // A terminal outcome of a single row: success+refunded is NOT delivered; superseded rows don't count.
  const outcomeOfRow = (i: any): "completed" | "failed" | null => {
    if (isSuperseded(i)) return null
    const mapped = mapItemStatus(i?.status)
    if (mapped === "completed") return i?.refunded_at ? null : "completed"
    return mapped === "failed" ? "failed" : null
  }
  const setOutcome = (ref: string, status: "completed" | "failed", row: any, fallbackMsisdn: unknown) => {
    result.set(ref, {
      status,
      externalStatus: String(row.status ?? ""),
      failedReason: row.failed_reason ?? null,
      msisdn: String(row.msisdn ?? fallbackMsisdn ?? ""),
      item: row,
    })
  }

  // Reference-bearing rows: either still in flight ("uploaded") and needing a paired
  // terminal row, or (if AGP echoes the reference on the terminal row) self-resolving.
  const pairingRows: any[] = []
  const seenRefs = new Set<string>()
  for (const i of list) {
    const ref = refOf(i)
    if (!ref || seenRefs.has(ref)) continue
    seenRefs.add(ref)
    const status = String(i?.status ?? "").toLowerCase().trim()
    const own = status === "uploaded" ? null : outcomeOfRow(i)
    if (own) {
      setOutcome(ref, own, i, i.msisdn)
    } else if (status === "uploaded" || mapItemStatus(i?.status) === "processing" || mapItemStatus(i?.status) === "pending") {
      pairingRows.push(i)
    }
  }
  const terminals = list.filter(
    i => refOf(i) === "" && String(i?.status ?? "").toLowerCase().trim() !== "uploaded" && !isSuperseded(i)
  )
  const candidatesFor = (up: any): any[] => {
    const key = msisdnKey(up.msisdn)
    if (!key) return []
    return terminals.filter(t => msisdnKey(t.msisdn) === key && sizesCompatible(up, t))
  }

  for (const up of pairingRows) {
    const cands = candidatesFor(up)
    if (cands.length === 0) continue

    const peers = pairingRows.filter(
      p => p !== up && msisdnKey(p.msisdn) === msisdnKey(up.msisdn) && sizesCompatible(up, p)
    )

    let chosen: any
    let status: "completed" | "failed" | null
    if (peers.length > 0) {
      // Several of our references target this number: the terminal rows can't be
      // attributed to a specific one, so accept only when the candidate terminal rows
      // number EXACTLY the references (one each) and all map to the same outcome.
      const group = [up, ...peers]
      const candRows = new Set<any>()
      for (const g of group) for (const t of candidatesFor(g)) candRows.add(t)
      if (candRows.size !== group.length) continue
      const outcomes = new Set(Array.from(candRows).map(t => outcomeOfRow(t) ?? "none"))
      if (outcomes.size !== 1) continue
      status = outcomeOfRow(Array.from(candRows)[0])
      // Never declare a failure for a shared-number group: two failed rows could both be
      // one order's retries while the other is still in flight, and a wrong "failed" triggers
      // a re-send (double delivery). Success rows are one-per-delivery, so they are safe.
      if (status !== "completed") continue
      chosen = [...candRows].sort((a, b) => createdMs(b) - createdMs(a))[0]
    } else {
      // Single reference: the newest terminal row is authoritative (later retry rounds
      // supersede earlier ones). Rows tied for newest must agree.
      const newestMs = Math.max(...cands.map(createdMs))
      const newest = cands.filter(t => createdMs(t) === newestMs)
      const outcomes = new Set(newest.map(t => outcomeOfRow(t) ?? "none"))
      if (outcomes.size !== 1) continue
      status = outcomeOfRow(newest[0])
      if (!status) continue
      chosen = newest[0]
    }
    setOutcome(refOf(up), status, chosen, up.msisdn)
  }
  return result
}

/** Fetch every item of an AgentPortalGH order (all pages). `complete` is false if any page failed or the page cap hit. */
export async function fetchAllItemsForOrder(orderId: string): Promise<{ items: any[]; complete: boolean }> {
  return fetchAllOrderItems(orderId)
}

/**
 * Look an order up on AgentPortalGH by phone + creation date and decide its outcome.
 * Pure of Supabase so it can also back the read-only reconcile script.
 * `hasAmbiguousSibling` only disables the legacy phone+size fallback — the exact
 * reference match through the batch's uploaded row is always safe.
 */
export async function resolveStatusFromAgp(
  id: string,
  phone: string | undefined,
  sizeGb: number | undefined,
  createdDate: string | undefined,
  opts: { hasAmbiguousSibling?: boolean } = {}
): Promise<MTNOrderStatusResponse> {
  const hasAmbiguousSibling = opts.hasAmbiguousSibling === true
  const orderIdOf = (o: any): string | undefined => o?.order_id ?? o?.id

  const today = new Date().toISOString().slice(0, 10)
  // Try the order's own creation date first (most precise), then today (covers
  // clock/timezone drift). Deliberately NO unscoped (date=undefined) fallback:
  // confirmed live 2026-07-30, an unscoped search returns a phone's ENTIRE
  // order history on AgentPortalGH's side with no day boundary at all, so a
  // repeat customer's brand-new order would match an old, already-completed
  // order for the same phone+size from days earlier.
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

      const sorted = [...orders].sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())

      // Batch match: AGP runs our item inside its own group order; the "uploaded"
      // row carries OUR reference and a separate terminal row carries the outcome.
      // Exact reference link, so safe even when sibling orders share phone+size.
      // Newest batch first: the NEWEST batch holding our reference decides (outcome, or
      // awaiting) — never fall back to an older batch once a newer one has our reference.
      // An incomplete item list (page failure / page cap) resolves nothing: stay awaiting
      // rather than guess from a partial view.
      const awaiting = { success: true, status: "processing" as const, message: "Order in AgentPortalGH batch, awaiting outcome" }
      for (const o of sorted) {
        const oid = orderIdOf(o)
        if (!oid) continue
        const { items, complete } = await fetchAllOrderItems(String(oid))
        if (!complete) {
          console.warn(`[AgentPortalGH] Incomplete item list for batch ${oid} while checking ${id} — staying in flight`)
          return awaiting
        }
        if (!items.some(i => typeof i?.reference === "string" && i.reference.trim() === id)) continue
        const hit = resolveBatchOutcomes(items).get(id)
        if (hit) {
          return {
            success: true,
            status: hit.status,
            message: hit.failedReason ?? hit.externalStatus,
            order: hit.item,
          }
        }
        return awaiting
      }

      // Legacy fallback: scan every matching batch's items, newest first. Skipped
      // when a sibling tracking row makes the phone+size match ambiguous — stays
      // "processing" rather than risk guessing wrong.
      if (hasAmbiguousSibling) {
        console.warn(`[AgentPortalGH] Skipping phone+size fallback for ${id} — ambiguous sibling tracking row(s) for ${phone}/${sizeGb}GB on ${date ?? "unscoped"}`)
        continue
      }
      for (const o of sorted) {
        const oid = orderIdOf(o)
        if (!oid || !phone) continue
        const { items } = await fetchAllOrderItems(String(oid))
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

    // The order request: an unreadable reply means AgentPortalGH may have queued it.
    const sent = await sendOrderRequest("AgentPortalGH", () =>
      apiFetch("/api/queue/add", {
        method: "POST",
        body: JSON.stringify(buildQueuePayload(phone, request.size_gb, reference, request.network)),
      })
    )
    if (!sent.ok) return sent.response
    const { res, json } = sent

    if (res.status === 402) {
      // Confirmed shape: { "error": "insufficient wallet balance: need GHS X, balance GHS Y" }
      return { success: false, message: json?.error ?? "Insufficient balance", error_type: "INSUFFICIENT_BALANCE" }
    }

    if (!res.ok) {
      // Confirmed error shape is { "error": "message" } — "message" is never the key.
      return { success: false, message: json?.error ?? json?.message ?? `API error ${res.status}`, error_type: "API_ERROR" }
    }

    // added === 0 means every item was rejected (whitelist block, validation,
    // or a stale/duplicate client_ref). No `held` flag either way: this stays
    // an ordinary failure so createMTNOrder's retry sequence still gets to
    // try the next provider, and if every provider fails the order simply
    // reverts to "pending" like any other failure — never specially held.
    if (json.added === 0) {
      const reason = (json.rejected as any[])?.[0]?.reason ?? "Order rejected by provider"
      return { success: false, message: reason, error_type: classifyRejectionReason(reason), order_id: reference }
    }

    return { success: true, order_id: reference, message: "Order queued" }
  }

  async checkOrderStatus(orderId: string | number): Promise<MTNOrderStatusResponse> {
    const id = String(orderId)
    if (isUnknownTrackingId(id)) return unknownStatusResult()

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

    // The AgentPortalGH lookups (exact reference match through the batch's
    // "uploaded" row, then the guarded phone+size fallback) live in
    // resolveStatusFromAgp so the read-only reconcile script shares them.
    return resolveStatusFromAgp(id, phone, sizeGb, createdDate, { hasAmbiguousSibling })
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
