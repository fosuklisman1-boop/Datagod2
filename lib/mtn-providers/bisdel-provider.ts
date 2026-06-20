/**
 * Bisdel MTN Provider
 *
 * Implements MTN fulfillment using the Bisdel (XX1) Agent API.
 * API host: https://bisdelgh.com/api/xx1
 *
 * Key differences from Sykes/DataKazina/EazyGhData:
 *  - Orders reference a product_id from a synced catalog (not size_gb), resolved
 *    by GB within a single admin-chosen category (collisions like "1GB Daily" vs
 *    "1GB Monthly" are disambiguated by category).
 *  - Auth via TWO headers: X-API-Key + X-API-Secret.
 *  - Status check keys on the string order_reference (not the numeric order_id),
 *    so we surface order_reference as our order_id and store it as the tracking
 *    mtn_order_id.
 */

import { generateTraceId, log } from "@/lib/mtn-production-config"
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat, validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"
import { supabaseAdmin } from "@/lib/supabase"

const BISDEL_API_KEY = process.env.BISDEL_API_KEY!
const BISDEL_API_SECRET = process.env.BISDEL_API_SECRET!
const BISDEL_BASE_URL = process.env.BISDEL_BASE_URL || "https://bisdelgh.com/api/xx1"
const REQUEST_TIMEOUT = 30000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "X-API-Key": BISDEL_API_KEY, "X-API-Secret": BISDEL_API_SECRET, ...(extra ?? {}) }
}

/**
 * Normalize a Bisdel status string into our canonical set.
 *
 * Mirrors the Sykes provider's mapping: only explicit pending values stay
 * pending, and any unknown / in-flight status falls through to "processing"
 * (NOT "pending"). Without this, a Bisdel in-flight status we don't explicitly
 * list would map to "pending" and the sync cron — seeing the tracking row is
 * already "pending" — would never advance the order, so it would sit at
 * "pending" instead of "processing" the way Sykes orders do.
 */
export function normalizeStatus(raw: string): "pending" | "processing" | "completed" | "failed" {
  const s = (raw || "").toLowerCase().trim().replace(/[\s-]+/g, "_")
  if (["completed", "complete", "success", "successful", "delivered", "done", "sent", "fulfilled"].includes(s)) return "completed"
  if (["failed", "error", "cancelled", "canceled", "rejected", "refunded", "expired"].includes(s)) return "failed"
  if (["pending", "waiting", "new"].includes(s)) return "pending"
  // Unknown / blank / any in-flight status → processing (matches Sykes)
  return "processing"
}

/** Parse a GB number from a Bisdel data_volume value e.g. "1GB", "1.5 GB", "500MB". */
export function parseGbFromVolume(volume: unknown): number | null {
  if (typeof volume === "number" && volume > 0) return volume
  if (typeof volume !== "string") return null
  const gb = volume.match(/(\d+(?:\.\d+)?)\s*GB/i)
  if (gb) return parseFloat(gb[1])
  const mb = volume.match(/(\d+(?:\.\d+)?)\s*MB/i)
  if (mb) return parseFloat(mb[1]) / 1024
  const bare = parseFloat(volume)
  return isNaN(bare) || bare <= 0 ? null : bare
}

export interface BisdelProduct {
  product_id: number | string
  data_volume?: string | number
  network?: string
  category?: string
  [k: string]: unknown
}

/**
 * Find the Bisdel product_id for a GB size, restricted to MTN + a single category.
 * Pure: takes the cached catalog + chosen category. Returns null on any miss.
 */
export function findProductIdInCatalog(
  packages: BisdelProduct[],
  category: string | null | undefined,
  sizeGb: number,
): number | string | null {
  if (!category) return null
  const target = Math.round(sizeGb)
  const match = packages.find(p => {
    if ((p.network ?? "").toString().toUpperCase() !== "MTN") return false
    if ((p.category ?? "").toString() !== category) return false
    const gb = parseGbFromVolume(p.data_volume)
    return gb !== null && Math.round(gb) === target
  })
  return match ? (match.product_id ?? null) : null
}

/** Load cached catalog + chosen category from admin_settings, then match. */
async function getProductId(sizeGb: number): Promise<{ id: number | string | null; reason?: string }> {
  try {
    const [{ data: pkgRow }, { data: catRow }] = await Promise.all([
      supabaseAdmin.from("admin_settings").select("value").eq("key", "bisdel_packages").maybeSingle(),
      supabaseAdmin.from("admin_settings").select("value").eq("key", "bisdel_category").maybeSingle(),
    ])
    const packages: BisdelProduct[] = pkgRow?.value?.packages ?? []
    const category: string | null = catRow?.value?.category ?? null
    if (!category) return { id: null, reason: "No Bisdel category configured. Choose one in admin settings." }
    if (packages.length === 0) return { id: null, reason: "No Bisdel products cached. Sync products in admin settings." }
    const id = findProductIdInCatalog(packages, category, sizeGb)
    if (!id) {
      const sizes = packages
        .filter(p => (p.category ?? "").toString() === category && (p.network ?? "").toString().toUpperCase() === "MTN")
        .map(p => parseGbFromVolume(p.data_volume))
        .filter(Boolean)
      return { id: null, reason: `No Bisdel "${category}" product for ${sizeGb}GB. Available: ${sizes.join(", ")}GB` }
    }
    return { id }
  } catch (error) {
    console.error("[Bisdel] Error resolving product_id:", error)
    return { id: null, reason: "Error reading Bisdel product catalog" }
  }
}

export class BisdelProvider implements MTNProvider {
  name = "bisdel"

  async createOrder(order: MTNOrderRequest): Promise<MTNOrderResponse> {
    const traceId = order.traceId || generateTraceId()
    const startTime = Date.now()
    try {
      log("info", "Order", "Creating MTN order via Bisdel", { traceId, network: order.network, sizeGb: order.size_gb })

      if (!isValidPhoneFormat(order.recipient_phone)) {
        return { success: false, message: `Invalid phone number format: ${order.recipient_phone}`, traceId, error_type: "VALIDATION" }
      }
      if (!validatePhoneNetworkMatch(order.recipient_phone, order.network)) {
        return { success: false, message: `Phone number does not match ${order.network} network`, traceId, error_type: "VALIDATION" }
      }

      const { id: productId, reason } = await getProductId(order.size_gb)
      if (!productId) {
        return { success: false, message: reason || `No Bisdel product for ${order.size_gb}GB`, traceId, error_type: "VALIDATION" }
      }

      const phone = normalizePhoneNumber(order.recipient_phone)
      const body: Record<string, unknown> = { product_id: productId, phone, quantity: 1 }
      if (order.client_ref) body.external_order_id = order.client_ref

      const maxRetries = 3
      const retryDelays = [2000, 5000, 10000]

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const response = await fetch(`${BISDEL_BASE_URL}/order.php`, {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT),
          })
          const latency = Date.now() - startTime
          const responseText = await response.text()

          if (response.status === 429) {
            if (attempt < maxRetries) { await sleep(retryDelays[attempt]); continue }
            return { success: false, message: "Bisdel rate limited. Please try again.", traceId, error_type: "RATE_LIMIT" }
          }

          let data: any
          try { data = JSON.parse(responseText) } catch {
            return { success: false, message: `Invalid Bisdel response: ${responseText.slice(0, 200)}`, traceId, error_type: "API_ERROR" }
          }

          // Bisdel nests the order under `data`.
          const d = data?.data ?? data
          const ok = response.ok && (data?.success === true || data?.code === 201 || data?.code === 200)

          if (!ok) {
            const errMsg: string = data?.error || d?.message || `Bisdel API returned ${response.status}`
            log("error", "Order", "Bisdel API error", { traceId, status: response.status, data })
            return { success: false, message: errMsg, traceId, error_type: "API_ERROR" }
          }

          // Status lookups key on order_reference, so surface it as our order_id.
          const orderReference = d?.order_reference ?? d?.order_id
          if (!orderReference) {
            return { success: false, message: d?.message || "Order placed but no order_reference returned", traceId, error_type: "API_ERROR" }
          }

          log("info", "Order", "Bisdel MTN order created", { traceId, orderReference, latencyMs: latency })
          return { success: true, order_id: orderReference, message: d?.message || "Order placed successfully", traceId }
        } catch (error) {
          if (attempt < maxRetries) { await sleep(retryDelays[attempt]); continue }
          throw error
        }
      }
      return { success: false, message: "Maximum retries exceeded", traceId, error_type: "API_ERROR" }
    } catch (error) {
      log("error", "Order", "Error creating Bisdel MTN order", { traceId, error: String(error) })
      return { success: false, message: error instanceof Error ? error.message : "Failed to create order", traceId, error_type: "NETWORK_ERROR" }
    }
  }

  async checkOrderStatus(orderReference: string | number): Promise<MTNOrderStatusResponse> {
    const traceId = generateTraceId()
    const maxRetries = 3
    const retryDelays = [2000, 5000, 10000]
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const url = `${BISDEL_BASE_URL}/status.php?order_reference=${encodeURIComponent(String(orderReference))}`
        const response = await fetch(url, { method: "GET", headers: authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
        const responseText = await response.text()

        if (response.status === 429) {
          if (attempt < maxRetries) { await sleep(retryDelays[attempt]); continue }
          return { success: false, message: "Rate limited while checking status (429)" }
        }
        if (response.status === 404) return { success: false, message: `Order ${orderReference} not found` }
        if (!response.ok) return { success: false, message: `API error: ${response.status} - ${responseText.slice(0, 100)}` }

        let data: any
        try { data = JSON.parse(responseText) } catch {
          return { success: false, message: `Invalid JSON: ${responseText.slice(0, 100)}` }
        }
        const d = data?.data ?? data
        const rawStatus = (d?.status ?? "").toString()
        const status = normalizeStatus(rawStatus)
        return { success: true, status, message: d?.message || `Status: ${rawStatus}`, order: d }
      } catch (error) {
        if (attempt < maxRetries) { await sleep(retryDelays[attempt]); continue }
        return { success: false, message: error instanceof Error ? error.message : "Failed to check status" }
      }
    }
    return { success: false, message: "Maximum retries exceeded for status check" }
  }

  async checkBalance(): Promise<number | null> {
    try {
      const response = await fetch(`${BISDEL_BASE_URL}/balance.php`, { method: "GET", headers: authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
      if (!response.ok) { console.warn(`[Bisdel] Balance check failed: ${response.status}`); return null }
      const data = await response.json()
      const d = data?.data ?? data
      const balance = d?.wallet_balance ?? d?.balance ?? d?.amount
      if (typeof balance === "number") return balance
      if (typeof balance === "string") { const p = parseFloat(balance); return isNaN(p) ? null : p }
      return null
    } catch (error) {
      console.error("[Bisdel] Error checking balance:", error)
      return null
    }
  }
}
