/**
 * Sykes MTN Provider
 * 
 * Implements MTN fulfillment using the Sykes API
 */

import { supabaseAdmin as supabase } from "@/lib/supabase"
import {
    mtnConfig,
    isCircuitBreakerOpen,
    isRateLimited,
    recordSuccess,
    recordFailure,
    recordRequest,
    recordMetrics,
    log,
    generateTraceId,
    classifyError,
} from "@/lib/mtn-production-config"
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"

// Import shared utilities from mtn-fulfillment
import {
    normalizePhoneNumber,
    isValidPhoneFormat,
    validatePhoneNetworkMatch,
} from "@/lib/mtn-fulfillment"

const MTN_API_KEY = mtnConfig.apiKey
const MTN_API_BASE_URL = mtnConfig.apiBaseUrl
const REQUEST_TIMEOUT = mtnConfig.requestTimeout

export class SykesProvider implements MTNProvider {
    name = "sykes"

    /**
     * Create order via Sykes API
     */
    async createOrder(order: MTNOrderRequest): Promise<MTNOrderResponse> {
        const traceId = order.traceId || generateTraceId()
        const startTime = Date.now()

        try {
            log("info", "Order", "Creating MTN order via Sykes", {
                traceId,
                network: order.network,
                sizeGb: order.size_gb,
            })

            // Check circuit breaker
            if (isCircuitBreakerOpen(mtnConfig)) {
                log("warn", "Order", "Circuit breaker is open - rejecting request", { traceId })
                return {
                    success: false,
                    message: "Service temporarily unavailable. Please try again later.",
                    traceId,
                    error_type: "CIRCUIT_BREAKER",
                }
            }

            // Check rate limit
            if (isRateLimited(mtnConfig)) {
                log("warn", "Order", "Rate limit exceeded", { traceId })
                return {
                    success: false,
                    message: "Too many requests. Please wait and try again.",
                    traceId,
                    error_type: "RATE_LIMIT",
                }
            }

            // Validate inputs
            if (!isValidPhoneFormat(order.recipient_phone)) {
                log("warn", "Order", "Invalid phone format", { traceId, phone: order.recipient_phone })
                return {
                    success: false,
                    message: `Invalid phone number format: ${order.recipient_phone}`,
                    traceId,
                    error_type: "VALIDATION",
                }
            }

            if (!validatePhoneNetworkMatch(order.recipient_phone, order.network)) {
                log("warn", "Order", "Phone/network mismatch", { traceId })
                return {
                    success: false,
                    message: `Phone number does not match ${order.network} network`,
                    traceId,
                    error_type: "VALIDATION",
                }
            }

            const normalized_phone = normalizePhoneNumber(order.recipient_phone)

            // Record request for rate limiting
            recordRequest()

            // Ensure size_gb is an integer (API requirement)
            const sizeGbInt = Math.round(order.size_gb)

            // Make API call
            log("debug", "Order", "Calling Sykes MTN API", { traceId })
            const response = await fetch(`${MTN_API_BASE_URL}/api/orders`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-API-KEY": MTN_API_KEY,
                    "X-Trace-ID": traceId,
                },
                body: JSON.stringify({
                    recipient_phone: normalized_phone,
                    network: order.network,
                    size_gb: sizeGbInt,
                }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT),
            })

            // Get raw response text (API sometimes returns PHP warnings before JSON)
            const responseText = await response.text()
            const latency = Date.now() - startTime

            // Extract JSON from response (strip any PHP warnings/HTML before the JSON)
            let data: MTNOrderResponse
            try {
                // Find the JSON object in the response (it starts with { and ends with })
                const jsonMatch = responseText.match(/\{[\s\S]*\}/)
                if (jsonMatch) {
                    data = JSON.parse(jsonMatch[0]) as MTNOrderResponse
                } else {
                    log("error", "Order", "No JSON found in API response", {
                        traceId,
                        responseText: responseText.slice(0, 500),
                    })
                    recordFailure(mtnConfig)
                    recordMetrics(false, latency)
                    return {
                        success: false,
                        message: `Invalid API response: ${responseText.slice(0, 200)}`,
                        traceId,
                        error_type: "API_ERROR",
                    }
                }
            } catch (parseError) {
                log("error", "Order", "Failed to parse API response", {
                    traceId,
                    responseText: responseText.slice(0, 500),
                    parseError,
                })
                recordFailure(mtnConfig)
                recordMetrics(false, latency)
                return {
                    success: false,
                    message: `Failed to parse API response: ${responseText.slice(0, 200)}`,
                    traceId,
                    error_type: "API_ERROR",
                }
            }

            // Check HTTP status first
            if (!response.ok) {
                log("error", "Order", "Sykes MTN API HTTP error", {
                    traceId,
                    status: response.status,
                    data,
                })
                recordFailure(mtnConfig)
                recordMetrics(false, latency)

                return {
                    success: false,
                    message: data.message || `API returned ${response.status}`,
                    traceId,
                    error_type: "API_ERROR",
                }
            }

            // Check JSON success field (API returns { success: true/false, ... })
            if (!data.success) {
                log("error", "Order", "Sykes MTN API returned error in response", { traceId, data })
                recordFailure(mtnConfig)
                recordMetrics(false, latency)

                return {
                    success: false,
                    message: data.message || "Order failed",
                    traceId,
                    error_type: "API_ERROR",
                }
            }

            // Success!
            recordSuccess()
            recordMetrics(true, latency)
            log("info", "Order", "Sykes MTN order created successfully", {
                traceId,
                orderId: data.order_id,
                latencyMs: latency,
            })

            return {
                ...data,
                traceId,
            }
        } catch (error) {
            const latency = Date.now() - startTime
            const classified = classifyError(error)

            log("error", "Order", "Error creating Sykes MTN order", {
                traceId,
                errorType: classified.type,
                message: classified.message,
            })

            recordFailure(mtnConfig)
            recordMetrics(false, latency)

            return {
                success: false,
                message: classified.userMessage,
                traceId,
                error_type: classified.type,
            }
        }
    }

    /**
     * Check order status from Sykes API
     */
    async checkOrderStatus(mtnOrderId: number): Promise<MTNOrderStatusResponse> {
        const traceId = generateTraceId()

        try {
            log("info", "StatusCheck", `Checking status for Sykes MTN order ${mtnOrderId}`, {
                traceId,
                mtnOrderId,
            })

            // The Sykes API GET /api/orders returns all orders, not a single one
            // So we fetch all orders and filter for the one we need
            const response = await fetch(`${MTN_API_BASE_URL}/api/orders?limit=5000`, {
                method: "GET",
                headers: {
                    "X-API-KEY": MTN_API_KEY,
                    "Content-Type": "application/json",
                },
            })

            const responseText = await response.text()
            log("info", "StatusCheck", `API response: ${response.status}`, { traceId, responseText })

            if (!response.ok) {
                return {
                    success: false,
                    message: `API error: ${response.status} - ${responseText}`,
                }
            }

            let data
            try {
                data = JSON.parse(responseText)
            } catch {
                return {
                    success: false,
                    message: `Invalid JSON response: ${responseText.slice(0, 100)}`,
                }
            }

            log("info", "StatusCheck", `Order status retrieved`, { traceId, data })

            // Handle various response formats
            let order
            let allOrders: any[] = []

            if (Array.isArray(data)) {
                allOrders = data
            } else if (data.order) {
                order = data.order
            } else if (data.data && Array.isArray(data.data)) {
                allOrders = data.data
            } else if (data.orders && Array.isArray(data.orders)) {
                allOrders = data.orders
            } else if (data.id) {
                order = data
            }

            // Find the order by ID
            if (!order && allOrders.length > 0) {
                order = allOrders.find(
                    (o: any) =>
                        o.id === mtnOrderId ||
                        o.id === String(mtnOrderId) ||
                        String(o.id) === String(mtnOrderId)
                )

                if (!order) {
                    order = allOrders.find(
                        (o: any) =>
                            o.order_id === mtnOrderId ||
                            o.order_id === String(mtnOrderId) ||
                            String(o.order_id) === String(mtnOrderId)
                    )
                }

                if (!order) {
                    console.log(
                        `[Sykes-STATUS] Order ${mtnOrderId} not found in ${allOrders.length} orders. Available IDs: ${allOrders.map((o: any) => o.id || o.order_id).slice(0, 10).join(", ")}`
                    )
                    return {
                        success: false,
                        message: `Order ${mtnOrderId} not found in API response (${allOrders.length} orders returned)`,
                    }
                }
            }

            if (!order || !order.status) {
                console.log(`[Sykes-STATUS] Order or status not found. Order:`, order, `Data:`, JSON.stringify(data).slice(0, 300))
                return {
                    success: false,
                    message: `Order not found or no status. Response: ${JSON.stringify(data).slice(0, 200)}`,
                }
            }

            // Normalize status from API to our expected values
            let normalizedStatus: "pending" | "processing" | "completed" | "failed" = "pending"
            const apiStatus = String(order.status).toLowerCase().trim()

            // Completed status variations
            if (
                apiStatus === "completed" ||
                apiStatus === "success" ||
                apiStatus === "delivered" ||
                apiStatus === "done" ||
                apiStatus === "fulfilled" ||
                apiStatus === "sent" ||
                apiStatus === "successful" ||
                apiStatus === "complete"
            ) {
                normalizedStatus = "completed"
            }
            // Failed status variations
            else if (
                apiStatus === "failed" ||
                apiStatus === "error" ||
                apiStatus === "cancelled" ||
                apiStatus === "rejected" ||
                apiStatus === "expired" ||
                apiStatus === "refunded"
            ) {
                normalizedStatus = "failed"
            }
            // Processing status variations
            else if (
                apiStatus === "processing" ||
                apiStatus === "in_progress" ||
                apiStatus === "queued" ||
                apiStatus === "in-progress" ||
                apiStatus === "sending" ||
                apiStatus === "submitted"
            ) {
                normalizedStatus = "processing"
            }
            // Pending status
            else if (apiStatus === "pending" || apiStatus === "waiting" || apiStatus === "new") {
                normalizedStatus = "pending"
            }
            // Unknown status - log it clearly
            else {
                console.warn(
                    `[Sykes-STATUS] ⚠️ UNKNOWN API status: "${order.status}" for order ${mtnOrderId} - defaulting to processing`
                )
                log("warn", "StatusCheck", `Unknown API status: ${order.status}, defaulting to processing`, {
                    traceId,
                })
                normalizedStatus = "processing"
            }

            console.log(`[Sykes-STATUS] Normalized: "${order.status}" -> "${normalizedStatus}"`)
            log("info", "StatusCheck", `Status normalized: ${order.status} -> ${normalizedStatus}`, {
                traceId,
            })

            return {
                success: true,
                status: normalizedStatus,
                message: order.message || "Status retrieved",
                order,
            }
        } catch (error) {
            log("error", "StatusCheck", `Error checking order status`, { traceId, error: String(error) })
            return {
                success: false,
                message: error instanceof Error ? error.message : "Failed to check status",
            }
        }
    }

    /**
     * Check Sykes wallet balance
     */
    async checkBalance(): Promise<number | null> {
        try {
            const response = await fetch(`${MTN_API_BASE_URL}/api/balance`, {
                method: "GET",
                headers: {
                    "X-API-KEY": MTN_API_KEY,
                    "Content-Type": "application/json",
                },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT),
            })

            if (!response.ok) {
                throw new Error(`Sykes API error: ${response.status} ${response.statusText}`)
            }

            // Get raw response text (API sometimes returns PHP warnings before JSON)
            const responseText = await response.text()

            // Extract JSON from response (strip any PHP warnings/HTML before the JSON)
            let data: Record<string, unknown>
            try {
                const jsonMatch = responseText.match(/\{[\s\S]*\}/)
                if (jsonMatch) {
                    data = JSON.parse(jsonMatch[0])
                } else {
                    console.warn("[Sykes] No JSON found in balance response:", responseText.slice(0, 500))
                    return null
                }
            } catch {
                console.warn("[Sykes] Failed to parse balance response:", responseText.slice(0, 500))
                return null
            }

            // API returns { success: true, balance: 1000.50 } or similar
            // Handle various response formats
            if (data.success !== false) {
                // Check for balance field (could be 'balance', 'wallet_balance', 'amount', etc.)
                const balance = data.balance ?? data.wallet_balance ?? data.amount
                if (typeof balance === "number") {
                    return balance
                }
                // Try parsing string balance
                if (typeof balance === "string") {
                    const parsed = parseFloat(balance)
                    if (!isNaN(parsed)) {
                        return parsed
                    }
                }
            }

            console.warn("[Sykes] Unexpected balance response format:", data)
            return null
        } catch (error) {
            console.error("[Sykes] Error checking balance:", error)
            return null
        }
    }
}
