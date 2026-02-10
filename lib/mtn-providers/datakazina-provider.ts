/**
 * DataKazina MTN Provider
 * 
 * Implements MTN fulfillment using the DataKazina API
 */

import { generateTraceId, log } from "@/lib/mtn-production-config"
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat, validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"

const DATAKAZINA_API_KEY = process.env.DATAKAZINA_API_KEY!
const DATAKAZINA_API_BASE_URL =
    process.env.DATAKAZINA_API_URL || "https://reseller.dakazinabusinessconsult.com/api/v1"
const REQUEST_TIMEOUT = 30000 // 30 seconds

// Network ID mapping for DataKazina
const NETWORK_ID_MAP = {
    MTN: 3,
    Telecel: 1, // TODO: Confirm with user
    AirtelTigo: 2, // TODO: Confirm with user
} as const

export class DataKazinaProvider implements MTNProvider {
    name = "datakazina"

    /**
     * Create order via DataKazina API
     */
    async createOrder(order: MTNOrderRequest): Promise<MTNOrderResponse> {
        const traceId = order.traceId || generateTraceId()
        const startTime = Date.now()

        try {
            log("info", "Order", "Creating MTN order via DataKazina", {
                traceId,
                network: order.network,
                sizeGb: order.size_gb,
            })

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
            const network_id = NETWORK_ID_MAP[order.network]

            // Generate unique reference for DataKazina
            const incoming_api_ref = `dk_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`

            // Map to DataKazina format
            const requestBody = {
                recipient_msisdn: normalized_phone,
                network_id,
                shared_bundle: order.size_gb, // Direct mapping: 5GB → 5
                incoming_api_ref,
            }

            log("debug", "Order", "Calling DataKazina API", { traceId, requestBody })

            // Make API call
            const response = await fetch(`${DATAKAZINA_API_BASE_URL}/buy-data-package`, {
                method: "POST",
                headers: {
                    "x-api-key": DATAKAZINA_API_KEY,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                body: JSON.stringify(requestBody),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT),
            })

            const latency = Date.now() - startTime
            const responseText = await response.text()

            // Parse response
            let data: any
            try {
                data = JSON.parse(responseText)
            } catch (parseError) {
                log("error", "Order", "Failed to parse DataKazina response", {
                    traceId,
                    responseText: responseText.slice(0, 500),
                    parseError,
                })
                return {
                    success: false,
                    message: `Invalid API response: ${responseText.slice(0, 200)}`,
                    traceId,
                    error_type: "API_ERROR",
                }
            }

            // Check for errors
            if (!response.ok) {
                log("error", "Order", "DataKazina API HTTP error", {
                    traceId,
                    status: response.status,
                    data,
                })
                return {
                    success: false,
                    message: data.message || `API returned ${response.status}`,
                    traceId,
                    error_type: "API_ERROR",
                }
            }

            // Check success field in response
            if (data.success === false || data.status === "error" || data.error) {
                log("error", "Order", "DataKazina API returned error", { traceId, data })
                return {
                    success: false,
                    message: data.message || data.error || "Order failed",
                    traceId,
                    error_type: "API_ERROR",
                }
            }

            // Extract transaction ID (field name may vary)
            const transaction_id =
                data.transaction_id || data.id || data.order_id || data.reference || incoming_api_ref

            log("info", "Order", "DataKazina MTN order created successfully", {
                traceId,
                transactionId: transaction_id,
                latencyMs: latency,
            })

            return {
                success: true,
                order_id: transaction_id,
                message: data.message || "Order created successfully",
                traceId,
            }
        } catch (error) {
            const latency = Date.now() - startTime
            log("error", "Order", "Error creating DataKazina MTN order", {
                traceId,
                error: String(error),
                latencyMs: latency,
            })

            return {
                success: false,
                message: error instanceof Error ? error.message : "Failed to create order",
                traceId,
                error_type: "NETWORK_ERROR",
            }
        }
    }

    /**
     * Check order status from DataKazina API
     */
    async checkOrderStatus(transactionId: string | number): Promise<MTNOrderStatusResponse> {
        const traceId = generateTraceId()

        try {
            log("info", "StatusCheck", `Checking status for DataKazina transaction ${transactionId}`, {
                traceId,
                transactionId,
            })

            const response = await fetch(`${DATAKAZINA_API_BASE_URL}/fetch-single-transaction`, {
                method: "POST",
                headers: {
                    "x-api-key": DATAKAZINA_API_KEY,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ transaction_id: String(transactionId) }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT),
            })

            const responseText = await response.text()

            if (!response.ok) {
                return {
                    success: false,
                    message: `API error: ${response.status} - ${responseText}`,
                }
            }

            let data: any
            try {
                data = JSON.parse(responseText)
            } catch {
                return {
                    success: false,
                    message: `Invalid JSON response: ${responseText.slice(0, 100)}`,
                }
            }

            log("info", "StatusCheck", `DataKazina transaction status retrieved`, { traceId, data, rawBody: responseText.slice(0, 1000) })

            // Handle error responses
            if (data.success === false || data.error || data.status === "error") {
                log("error", "StatusCheck", "DataKazina returned error status", { traceId, data })
                return {
                    success: false,
                    message: data.message || data.error || "Failed to fetch transaction",
                }
            }

            // Extract status from response
            const transaction = data.transaction || data.data || data
            const apiStatus = String(transaction.status || data.status || "pending")
                .toLowerCase()
                .trim()

            // Normalize status to our expected values
            let normalizedStatus: "pending" | "processing" | "completed" | "failed" = "pending"

            if (
                apiStatus === "completed" ||
                apiStatus === "success" ||
                apiStatus === "successful" ||
                apiStatus === "delivered" ||
                apiStatus === "done"
            ) {
                normalizedStatus = "completed"
            } else if (
                apiStatus === "failed" ||
                apiStatus === "error" ||
                apiStatus === "cancelled" ||
                apiStatus === "rejected"
            ) {
                normalizedStatus = "failed"
            } else if (
                apiStatus === "processing" ||
                apiStatus === "in_progress" ||
                apiStatus === "queued" ||
                apiStatus === "pending_delivery"
            ) {
                normalizedStatus = "processing"
            } else {
                normalizedStatus = "pending"
            }

            log("info", "StatusCheck", `Status normalized: ${apiStatus} -> ${normalizedStatus}`, {
                traceId,
            })

            return {
                success: true,
                status: normalizedStatus,
                message: data.message || "Status retrieved",
                order: transaction,
            }
        } catch (error) {
            // Enhanced error logging for network issues
            const errorDetails: any = {
                traceId,
                error: String(error),
                errorType: error instanceof Error ? error.constructor.name : typeof error,
            }

            // Add additional context for fetch errors
            if (error instanceof TypeError && error.message.includes('fetch failed')) {
                errorDetails.likelyReason = "Network connectivity issue - API may be down or unreachable"
                errorDetails.apiUrl = `${DATAKAZINA_API_BASE_URL}/fetch-single-transaction`
                log("error", "StatusCheck", `DataKazina API unreachable (network error)`, errorDetails)
            } else {
                log("error", "StatusCheck", `Error checking DataKazina status`, errorDetails)
            }

            return {
                success: false,
                message: error instanceof Error ? error.message : "Failed to check status",
            }
        }
    }

    /**
     * Check DataKazina console balance
     */
    async checkBalance(): Promise<number | null> {
        try {
            const response = await fetch(`${DATAKAZINA_API_BASE_URL}/check-console-balance`, {
                method: "GET",
                headers: {
                    "x-api-key": DATAKAZINA_API_KEY,
                },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT),
            })

            if (!response.ok) {
                console.warn(`[DataKazina] Balance check failed: ${response.status}`)
                return null
            }

            const data = await response.json()

            // DataKazina returns balance in 'Wallet Balance' field (capital W, with space)
            const balance = data['Wallet Balance'] ?? data.balance ?? data.wallet_balance ?? data.amount ?? data.console_balance

            if (typeof balance === "number") {
                return balance
            }

            if (typeof balance === "string") {
                const parsed = parseFloat(balance)
                if (!isNaN(parsed)) {
                    return parsed
                }
            }

            console.warn("[DataKazina] Unexpected balance response format:", data)
            return null
        } catch (error) {
            console.error("[DataKazina] Error checking balance:", error)
            return null
        }
    }
}
