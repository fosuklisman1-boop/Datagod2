/**
 * Xpress MTN Provider
 *
 * Implements MTN fulfillment using the Xpress Agent API.
 * Docs: https://labppmcqsdeuollwcgwu.supabase.co/functions/v1/agent-api
 *
 * Key differences from Sykes/DataKazina:
 *  - Batch-first API (1–1000 items); we send one item per call to match our tracking model
 *  - Auth via X-API-Key header
 *  - order_id is a UUID string (not an integer)
 *  - Status check fetches a single order by UUID, not a bulk list
 *  - Failed items are auto-refunded by the provider
 */

import { generateTraceId, log } from "@/lib/mtn-production-config"
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat, validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"

const XPRESS_API_KEY = process.env.XPRESS_KEY!
const XPRESS_API_BASE_URL = "https://labppmcqsdeuollwcgwu.supabase.co/functions/v1/agent-api"
const REQUEST_TIMEOUT = 30000

// Xpress uses lowercase service strings
const NETWORK_SERVICE_MAP: Record<string, string> = {
    MTN: "mtn",
    Telecel: "telecel",
    AirtelTigo: "airteltigo",
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeStatus(raw: string): "pending" | "processing" | "completed" | "failed" {
    const s = raw.toLowerCase().trim()
    if (["completed", "success", "successful", "delivered", "done"].includes(s)) return "completed"
    if (["failed", "error", "cancelled", "rejected", "refunded"].includes(s)) return "failed"
    if (["processing", "in_progress", "queued", "submitted"].includes(s)) return "processing"
    return "pending"
}

export class XpressProvider implements MTNProvider {
    name = "xpress"

    async createOrder(order: MTNOrderRequest): Promise<MTNOrderResponse> {
        const traceId = order.traceId || generateTraceId()
        const startTime = Date.now()

        try {
            log("info", "Order", "Creating MTN order via Xpress", {
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

            const msisdn = normalizePhoneNumber(order.recipient_phone)
            const service = NETWORK_SERVICE_MAP[order.network] ?? "mtn"
            // Unique idempotency reference per item — replays within 24h return original result
            const reference = `xp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`

            const requestBody = {
                service,
                items: [{ msisdn, data_gb: order.size_gb, reference }],
            }

            log("debug", "Order", "Calling Xpress API", { traceId, requestBody })

            const maxRetries = 3
            const retryDelays = [2000, 5000, 10000]

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    const response = await fetch(`${XPRESS_API_BASE_URL}/orders`, {
                        method: "POST",
                        headers: {
                            "X-API-Key": XPRESS_API_KEY,
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify(requestBody),
                        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
                    })

                    const latency = Date.now() - startTime
                    const responseText = await response.text()

                    // 429 rate limit — back off and retry
                    if (response.status === 429) {
                        if (attempt < maxRetries) {
                            const delay = retryDelays[attempt]
                            log("warn", "Order", `Xpress rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`, { traceId })
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
                        log("error", "Order", "Xpress API HTTP error", { traceId, status: response.status, data })
                        return { success: false, message: data?.error || `API returned ${response.status}`, traceId, error_type: "API_ERROR" }
                    }

                    // Response: { order_id, items, charged, balance }
                    if (!data.order_id) {
                        log("error", "Order", "Xpress response missing order_id", { traceId, data })
                        return { success: false, message: data?.error || "Order created but no order_id returned", traceId, error_type: "API_ERROR" }
                    }

                    log("info", "Order", "Xpress MTN order created successfully", { traceId, orderId: data.order_id, latencyMs: latency })

                    return {
                        success: true,
                        order_id: data.order_id,
                        message: `Order placed. Charged ₵${data.charged ?? "?"}`,
                        traceId,
                    }
                } catch (error) {
                    if (attempt < maxRetries) {
                        const delay = retryDelays[attempt]
                        log("warn", "Order", `Xpress request failed, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`, { traceId, error: String(error) })
                        await sleep(delay)
                        continue
                    }
                    throw error
                }
            }

            return { success: false, message: "Maximum retries exceeded", traceId, error_type: "API_ERROR" }
        } catch (error) {
            log("error", "Order", "Error creating Xpress MTN order", { traceId, error: String(error) })
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
                log("info", "StatusCheck", `Checking Xpress order ${orderId} (attempt ${attempt + 1})`, { traceId })

                const response = await fetch(`${XPRESS_API_BASE_URL}/orders/${orderId}`, {
                    method: "GET",
                    headers: { "X-API-Key": XPRESS_API_KEY },
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

                // Use first item status as the canonical status for single-item orders
                const firstItem = Array.isArray(data.items) ? data.items[0] : null
                const rawStatus = firstItem?.status || data.status || "pending"
                const normalizedStatus = normalizeStatus(rawStatus)

                log("info", "StatusCheck", `Xpress status: ${rawStatus} -> ${normalizedStatus}`, { traceId })

                return {
                    success: true,
                    status: normalizedStatus,
                    message: `Status: ${rawStatus}`,
                    order: data,
                }
            } catch (error) {
                if (attempt < maxRetries) {
                    await sleep(retryDelays[attempt])
                    continue
                }
                log("error", "StatusCheck", "Error checking Xpress order status", { traceId, error: String(error) })
                return { success: false, message: error instanceof Error ? error.message : "Failed to check status" }
            }
        }

        return { success: false, message: "Maximum retries exceeded for status check" }
    }

    async checkBalance(): Promise<number | null> {
        try {
            const response = await fetch(`${XPRESS_API_BASE_URL}/wallet`, {
                method: "GET",
                headers: { "X-API-Key": XPRESS_API_KEY },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT),
            })

            if (!response.ok) {
                console.warn(`[Xpress] Balance check failed: ${response.status}`)
                return null
            }

            const data = await response.json()
            // Response: { balance_ghs: 481.00, updated_at: "..." }
            const balance = data.balance_ghs ?? data.balance ?? data.amount

            if (typeof balance === "number") return balance
            if (typeof balance === "string") {
                const parsed = parseFloat(balance)
                return isNaN(parsed) ? null : parsed
            }

            return null
        } catch (error) {
            console.error("[Xpress] Error checking balance:", error)
            return null
        }
    }
}
