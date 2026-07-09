/**
 * EazyGhData MTN Provider
 *
 * Implements MTN fulfillment using the EazyGhData Agent API.
 * Docs: https://eazyghdata.com
 *
 * Key differences from Sykes/DataKazina:
 *  - Orders require a package_id UUID (not size_gb) — looked up from admin_settings
 *  - Auth via X-API-Key header
 *  - order_id is a UUID string
 *  - Status check is per-order: GET /api/agent/v1/orders?order_id=uuid
 */

import { generateTraceId, log } from "@/lib/mtn-production-config"
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat, validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"
import { supabaseAdmin } from "@/lib/supabase"

const EAZYGHDATA_API_KEY = process.env.EAZYGHDATA_API_KEY!
const EAZYGHDATA_BASE_URL = process.env.EAZYGHDATA_BASE_URL || "https://eazyghdata.com"
const REQUEST_TIMEOUT = 30000

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeStatus(raw: string): "pending" | "processing" | "completed" | "failed" {
    const s = raw.toLowerCase().trim().replace(/[\s-]+/g, "_")
    if (["completed", "complete", "success", "successful", "delivered", "done", "sent"].includes(s)) return "completed"
    if (["failed", "error", "cancelled", "canceled", "rejected", "refunded"].includes(s)) return "failed"
    if (["processing", "in_progress", "queued", "submitted", "accepted", "ongoing"].includes(s)) return "processing"
    return "pending"
}

/**
 * EazyGhData wraps the order object differently across endpoints. Search
 * direct fields, then common nested wrappers (data/order/result/orders[0]).
 */
function extractOrderStatus(data: any): { rawStatus: string; order: any } {
    const statusFields = ["status", "order_status", "delivery_status", "state"]

    const tryObject = (obj: any): string | null => {
        if (!obj || typeof obj !== "object") return null
        for (const f of statusFields) {
            if (typeof obj[f] === "string" && obj[f].length > 0) return obj[f]
        }
        return null
    }

    // Direct
    let status = tryObject(data)
    if (status) return { rawStatus: status, order: data }

    // Nested object wrappers: data.data, data.order, data.result
    for (const key of ["data", "order", "result"]) {
        const nested = data?.[key]
        if (Array.isArray(nested) && nested.length > 0) {
            status = tryObject(nested[0])
            if (status) return { rawStatus: status, order: nested[0] }
        } else {
            status = tryObject(nested)
            if (status) return { rawStatus: status, order: nested }
        }
    }

    // Array wrapper: data.orders[0]
    if (Array.isArray(data?.orders) && data.orders.length > 0) {
        status = tryObject(data.orders[0])
        if (status) return { rawStatus: status, order: data.orders[0] }
    }

    return { rawStatus: "pending", order: data }
}

/**
 * Extract GB value from a package object by trying every plausible field name,
 * then falling back to parsing the name/label string (e.g. "1GB", "1.5 GB").
 */
function extractGbFromPackage(p: Record<string, unknown>): number | null {
    // Numeric fields first
    const numericFields = ["size_gb", "data_gb", "capacity_gb", "volume_gb", "gb", "capacity", "volume", "size", "data", "amount"]
    for (const field of numericFields) {
        const v = p[field]
        if (typeof v === "number" && v > 0) return v
        if (typeof v === "string") {
            const n = parseFloat(v)
            if (!isNaN(n) && n > 0) return n
        }
    }
    // Parse "1GB", "1.5 GB", "1000MB" etc. from name/label fields
    const textFields = ["name", "label", "description", "package_name", "title", "plan"]
    for (const field of textFields) {
        const v = p[field]
        if (typeof v !== "string") continue
        const gbMatch = v.match(/(\d+(?:\.\d+)?)\s*GB/i)
        if (gbMatch) return parseFloat(gbMatch[1])
        const mbMatch = v.match(/(\d+(?:\.\d+)?)\s*MB/i)
        if (mbMatch) return parseFloat(mbMatch[1]) / 1024
    }
    return null
}

/**
 * Look up the EazyGhData package_id UUID for a given GB size and network.
 * Packages are cached in admin_settings under key "eazyghdata_packages".
 * Filters to MTN packages first to prevent accidentally picking an AT/Telecel
 * package with the same GB size (EazyGhData syncs all networks together).
 */
async function getPackageId(sizeGb: number, network = "MTN"): Promise<string | null> {
    try {
        const { data } = await supabaseAdmin
            .from("admin_settings")
            .select("value")
            .eq("key", "eazyghdata_packages")
            .maybeSingle()

        const packages: Array<Record<string, unknown>> = data?.value?.packages ?? []

        if (packages.length > 0) {
            console.log(`[EazyGhData] Package sample (first):`, JSON.stringify(packages[0]))
        } else {
            console.warn("[EazyGhData] No packages cached in admin_settings")
        }

        // Normalize the requested network for comparison (e.g. "AirtelTigo" → "AT")
        const normalizeNet = (n: string) => {
            const u = n.toUpperCase().trim()
            if (u === "AIRTELTIGO" || u.startsWith("AT")) return "AT"
            if (u === "TELECEL") return "TELECEL"
            return "MTN"
        }
        const targetNet = normalizeNet(network)

        // Filter to packages matching the requested network, fall back to all if none tagged
        const networkPackages = packages.filter(p => {
            const pNet = typeof p.network === "string" ? normalizeNet(p.network) : null
            return pNet === targetNet
        })
        const searchPool = networkPackages.length > 0 ? networkPackages : packages

        if (networkPackages.length === 0 && packages.length > 0) {
            console.warn(`[EazyGhData] No packages tagged as ${targetNet} — searching all ${packages.length} packages (may include other networks)`)
        }

        const match = searchPool.find(p => {
            const gb = extractGbFromPackage(p)
            if (gb === null) return false
            return Math.round(gb) === Math.round(sizeGb)
        })

        if (!match) {
            const found = searchPool.map(p => extractGbFromPackage(p)).filter(Boolean)
            console.warn(`[EazyGhData] No ${targetNet} package match for ${sizeGb}GB. Available sizes: ${found.join(", ")}GB`)
        }

        return (match?.id ?? match?.package_id ?? null) as string | null
    } catch (error) {
        console.error("[EazyGhData] Error fetching package mapping:", error)
        return null
    }
}

export class EazyGhDataProvider implements MTNProvider {
    name = "eazyghdata"

    async createOrder(order: MTNOrderRequest): Promise<MTNOrderResponse> {
        const traceId = order.traceId || generateTraceId()
        const startTime = Date.now()

        try {
            log("info", "Order", "Creating MTN order via EazyGhData", {
                traceId,
                network: order.network,
                sizeGb: order.size_gb,
            })

            if (!isValidPhoneFormat(order.recipient_phone)) {
                return { success: false, message: `Invalid phone number format: ${order.recipient_phone}`, traceId, error_type: "VALIDATION" }
            }

            if (!validatePhoneNetworkMatch(order.recipient_phone, order.network)) {
                return { success: false, message: `Phone number does not match ${order.network} network`, traceId, error_type: "VALIDATION" }
            }

            const packageId = await getPackageId(order.size_gb, order.network)
            if (!packageId) {
                return {
                    success: false,
                    message: `No EazyGhData package found for ${order.size_gb}GB. Please sync packages in admin settings.`,
                    traceId,
                    error_type: "VALIDATION",
                }
            }

            const phoneNumber = normalizePhoneNumber(order.recipient_phone)

            const requestBody = { package_id: packageId, phone_number: phoneNumber }

            log("debug", "Order", "Calling EazyGhData API", { traceId, requestBody })

            const maxRetries = 3
            const retryDelays = [2000, 5000, 10000]

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    const response = await fetch(`${EAZYGHDATA_BASE_URL}/api/agent/v1/order`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "X-API-Key": EAZYGHDATA_API_KEY,
                        },
                        body: JSON.stringify(requestBody),
                        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
                    })

                    const latency = Date.now() - startTime
                    const responseText = await response.text()

                    if (response.status === 429) {
                        if (attempt < maxRetries) {
                            const delay = retryDelays[attempt]
                            log("warn", "Order", `EazyGhData rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`, { traceId })
                            await sleep(delay)
                            continue
                        }
                        return { success: false, message: "Service temporarily unavailable due to rate limiting. Please try again.", traceId, error_type: "RATE_LIMIT" }
                    }

                    let data: any
                    try {
                        data = JSON.parse(responseText)
                    } catch {
                        return { success: false, message: `Invalid API response: ${responseText.slice(0, 200)}`, traceId, error_type: "API_ERROR" }
                    }

                    if (!response.ok) {
                        const errMsg: string = data?.message || data?.error || `API returned ${response.status}`
                        log("error", "Order", "EazyGhData API HTTP error", { traceId, status: response.status, data })

                        // Duplicate in-flight order — surface a clear message
                        if (errMsg.includes("duplicate key") || errMsg.includes("inflight")) {
                            return {
                                success: false,
                                message: "This phone number already has a pending EazyGhData order. Please wait for it to complete or fail before retrying.",
                                traceId,
                                error_type: "API_ERROR",
                            }
                        }

                        return { success: false, message: errMsg, traceId, error_type: "API_ERROR" }
                    }

                    const orderId = data.order_id ?? data.id
                    if (!orderId) {
                        log("error", "Order", "EazyGhData response missing order_id", { traceId, data })
                        return { success: false, message: data?.message || "Order created but no order_id returned", traceId, error_type: "API_ERROR" }
                    }

                    log("info", "Order", "EazyGhData MTN order created successfully", { traceId, orderId, latencyMs: latency })

                    return {
                        success: true,
                        order_id: orderId,
                        message: data.message || "Order placed successfully",
                        traceId,
                    }
                } catch (error) {
                    if (attempt < maxRetries) {
                        const delay = retryDelays[attempt]
                        log("warn", "Order", `EazyGhData request failed, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`, { traceId, error: String(error) })
                        await sleep(delay)
                        continue
                    }
                    throw error
                }
            }

            return { success: false, message: "Maximum retries exceeded", traceId, error_type: "API_ERROR" }
        } catch (error) {
            log("error", "Order", "Error creating EazyGhData MTN order", { traceId, error: String(error) })
            return {
                success: false,
                message: error instanceof Error ? error.message : "Failed to create order",
                traceId,
                error_type: "NETWORK_ERROR",
            }
        }
    }

    async checkOrderStatus(orderId: string | number): Promise<MTNOrderStatusResponse> {
        const traceId = generateTraceId()
        const maxRetries = 3
        const retryDelays = [2000, 5000, 10000]

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                log("info", "StatusCheck", `Checking EazyGhData order ${orderId} (attempt ${attempt + 1})`, { traceId })

                const response = await fetch(`${EAZYGHDATA_BASE_URL}/api/agent/v1/orders?order_id=${orderId}`, {
                    method: "GET",
                    headers: { "X-API-Key": EAZYGHDATA_API_KEY },
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
                })

                const responseText = await response.text()

                if (response.status === 429) {
                    if (attempt < maxRetries) {
                        await sleep(retryDelays[attempt])
                        continue
                    }
                    return { success: false, message: "Rate limited while checking status" }
                }

                if (response.status === 404) {
                    return { success: false, message: `Order ${orderId} not found` }
                }

                if (!response.ok) {
                    return { success: false, message: `API error: ${response.status} - ${responseText.slice(0, 100)}` }
                }

                let data: any
                try {
                    data = JSON.parse(responseText)
                } catch {
                    return { success: false, message: `Invalid JSON response: ${responseText.slice(0, 100)}` }
                }

                console.log(`[EazyGhData] Raw status response for ${orderId}:`, JSON.stringify(data))

                const { rawStatus, order } = extractOrderStatus(data)
                const normalizedStatus = normalizeStatus(rawStatus)

                log("info", "StatusCheck", `EazyGhData status: ${rawStatus} -> ${normalizedStatus}`, { traceId })

                return {
                    success: true,
                    status: normalizedStatus,
                    message: data.message || `Status: ${rawStatus}`,
                    order,
                }
            } catch (error) {
                if (attempt < maxRetries) {
                    await sleep(retryDelays[attempt])
                    continue
                }
                log("error", "StatusCheck", "Error checking EazyGhData order status", { traceId, error: String(error) })
                return { success: false, message: error instanceof Error ? error.message : "Failed to check status" }
            }
        }

        return { success: false, message: "Maximum retries exceeded for status check" }
    }

    async checkBalance(): Promise<number | null> {
        try {
            const response = await fetch(`${EAZYGHDATA_BASE_URL}/api/agent/v1/balance`, {
                method: "GET",
                headers: { "X-API-Key": EAZYGHDATA_API_KEY },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT),
            })

            if (!response.ok) {
                console.warn(`[EazyGhData] Balance check failed: ${response.status}`)
                return null
            }

            const data = await response.json()
            // Response: { balance: 1500.25, tier: "super_agent", name: "Agent Name" }
            const balance = data.balance ?? data.wallet_balance ?? data.amount

            if (typeof balance === "number") return balance
            if (typeof balance === "string") {
                const parsed = parseFloat(balance)
                return isNaN(parsed) ? null : parsed
            }

            return null
        } catch (error) {
            console.error("[EazyGhData] Error checking balance:", error)
            return null
        }
    }
}
