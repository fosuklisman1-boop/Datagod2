/**
 * CodeCraft MTN Provider
 *
 * Implements MTN fulfillment using the CodeCraft Network API.
 * Reuses the same API key/URL already used for AT-iShare and Telecel orders.
 *
 * Key differences from other MTN providers:
 *  - No dedicated balance endpoint — checkBalance() returns null
 *  - order_id is the reference_id string (e.g. "API-XXXXXXXX") returned by /initiate.php
 *  - Status lives at data.order_status inside the response body
 *  - Auth via x-api-key header (lowercase)
 */

import { generateTraceId, log } from "@/lib/mtn-production-config"
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat, validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"

const CODECRAFT_API_URL = process.env.CODECRAFT_API_URL || "https://api.codecraftnetwork.com/api"
const CODECRAFT_API_KEY = process.env.CODECRAFT_API_KEY!
const REQUEST_TIMEOUT = 30000

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeCodeCraftStatus(raw: string): "pending" | "processing" | "completed" | "failed" {
    const s = raw.toLowerCase().trim()
    if (["successful", "success", "delivered", "completed", "done", "sent"].includes(s)) return "completed"
    if (["failed", "failure", "cancelled", "canceled", "error", "rejected"].includes(s)) return "failed"
    if (["processing", "in progress", "in_progress", "queued", "submitted"].includes(s)) return "processing"
    return "pending"
}

export class CodeCraftMTNProvider implements MTNProvider {
    name = "codecraft"

    async createOrder(order: MTNOrderRequest): Promise<MTNOrderResponse> {
        const traceId = order.traceId || generateTraceId()
        const startTime = Date.now()

        try {
            log("info", "Order", "Creating MTN order via CodeCraft", {
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

            const phoneNumber = normalizePhoneNumber(order.recipient_phone)
            // CodeCraft infers network from the phone number — do not send a network field
            const requestBody = {
                recipient_number: phoneNumber,
                gig: String(order.size_gb),
            }

            log("debug", "Order", "Calling CodeCraft API", { traceId, requestBody })

            const maxRetries = 3
            const retryDelays = [2000, 5000, 10000]

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    const response = await fetch(`${CODECRAFT_API_URL}/initiate.php`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "x-api-key": CODECRAFT_API_KEY,
                        },
                        body: JSON.stringify(requestBody),
                        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
                    })

                    const latency = Date.now() - startTime
                    const responseText = await response.text()

                    let data: any
                    try {
                        data = JSON.parse(responseText)
                    } catch {
                        return { success: false, message: `Invalid API response: ${responseText.slice(0, 200)}`, traceId, error_type: "API_ERROR" }
                    }

                    // CodeCraft-specific error codes
                    if (data.status === 100) return { success: false, message: "CodeCraft wallet balance is low. Please top up.", traceId, error_type: "API_ERROR" }
                    if (data.status === 101) return { success: false, message: "Package out of stock on CodeCraft. Try another provider.", traceId, error_type: "API_ERROR" }
                    if (data.status === 102) return { success: false, message: "CodeCraft agent not found.", traceId, error_type: "API_ERROR" }
                    if (data.status === 103) return { success: false, message: "Package price not found on CodeCraft.", traceId, error_type: "API_ERROR" }
                    if (data.status === 555) return { success: false, message: "Network not supported on CodeCraft.", traceId, error_type: "API_ERROR" }

                    if (data.status === 500) {
                        if (attempt < maxRetries) { await sleep(retryDelays[attempt]); continue }
                        return { success: false, message: data.message || "CodeCraft internal error", traceId, error_type: "API_ERROR" }
                    }

                    if (data.status !== 200) {
                        return { success: false, message: data.message || `CodeCraft returned status ${data.status}`, traceId, error_type: "API_ERROR" }
                    }

                    const referenceId = data.reference_id
                    if (!referenceId) {
                        return { success: false, message: "Order created but no reference_id returned", traceId, error_type: "API_ERROR" }
                    }

                    log("info", "Order", "CodeCraft MTN order created successfully", { traceId, referenceId, latencyMs: latency })

                    return {
                        success: true,
                        order_id: referenceId,
                        message: data.message || "Order placed successfully",
                        traceId,
                    }
                } catch (error) {
                    if (attempt < maxRetries) {
                        log("warn", "Order", `CodeCraft request failed, retrying in ${retryDelays[attempt]}ms`, { traceId, error: String(error) })
                        await sleep(retryDelays[attempt])
                        continue
                    }
                    throw error
                }
            }

            return { success: false, message: "Maximum retries exceeded", traceId, error_type: "API_ERROR" }
        } catch (error) {
            log("error", "Order", "Error creating CodeCraft MTN order", { traceId, error: String(error) })
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

        try {
            log("info", "StatusCheck", `Checking CodeCraft order ${orderId}`, { traceId })

            const response = await fetch(
                `${CODECRAFT_API_URL}/status.php?reference_id=${orderId}`,
                {
                    method: "GET",
                    headers: { "x-api-key": CODECRAFT_API_KEY },
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
                }
            )

            const responseText = await response.text()

            if (!response.ok) {
                return { success: false, message: `API error: ${response.status} - ${responseText.slice(0, 100)}` }
            }

            let data: any
            try {
                data = JSON.parse(responseText)
            } catch {
                return { success: false, message: `Invalid JSON response: ${responseText.slice(0, 100)}` }
            }

            // Response shape: { status:200, data: { order_status: "Pending|Successful|..." } }
            const rawStatus: string = data?.data?.order_status || data?.order_status || "Pending"
            const normalizedStatus = normalizeCodeCraftStatus(rawStatus)

            log("info", "StatusCheck", `CodeCraft status: ${rawStatus} -> ${normalizedStatus}`, { traceId })

            return {
                success: true,
                status: normalizedStatus,
                message: data.message || `Status: ${rawStatus}`,
                order: data,
            }
        } catch (error) {
            log("error", "StatusCheck", "Error checking CodeCraft MTN order status", { traceId, error: String(error) })
            return { success: false, message: error instanceof Error ? error.message : "Failed to check status" }
        }
    }

    async checkBalance(): Promise<number | null> {
        try {
            const response = await fetch(`${CODECRAFT_API_URL}/wallet.php`, {
                method: "GET",
                headers: { "x-api-key": CODECRAFT_API_KEY },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT),
            })

            if (!response.ok) {
                console.warn(`[CodeCraft] Balance check failed: ${response.status}`)
                return null
            }

            const data = await response.json()
            // Response: { status:200, data: { wallet: 10.00 } }
            const balance = data?.data?.wallet ?? data?.wallet
            if (typeof balance === "number") return balance
            if (typeof balance === "string") {
                const parsed = parseFloat(balance)
                return isNaN(parsed) ? null : parsed
            }
            return null
        } catch (error) {
            console.error("[CodeCraft] Error checking balance:", error)
            return null
        }
    }
}
