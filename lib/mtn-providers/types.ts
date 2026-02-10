/**
 * MTN Provider Types
 * 
 * Common interfaces and types for all MTN fulfillment providers
 */

// Shared request/response types from existing mtn-fulfillment.ts
export interface MTNOrderRequest {
    recipient_phone: string
    network: "MTN" | "Telecel" | "AirtelTigo"
    size_gb: number
    traceId?: string
}

export interface MTNOrderResponse {
    success: boolean
    order_id?: number | string
    message: string
    traceId?: string
    error_type?: string
}

export interface MTNOrderStatusResponse {
    success: boolean
    status?: "pending" | "processing" | "completed" | "failed"
    message: string
    order?: any
}

/**
 * Provider Interface
 * All MTN providers must implement this interface
 */
export interface MTNProvider {
    /** Provider name (sykes, datakazina, etc.) */
    name: string

    /**
     * Create an order via the provider's API
     */
    createOrder(request: MTNOrderRequest): Promise<MTNOrderResponse>

    /**
     * Check order status by ID
     * Note: ID type may vary by provider (number vs string)
     */
    checkOrderStatus(orderId: string | number): Promise<MTNOrderStatusResponse>

    /**
     * Check wallet/console balance
     */
    checkBalance(): Promise<number | null>
}

/**
 * Supported provider names
 */
export type MTNProviderName = "sykes" | "datakazina"
