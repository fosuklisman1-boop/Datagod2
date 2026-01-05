import { supabase } from "@/lib/supabase"
import crypto from "crypto"

export interface MTNOrderRequest {
  recipient_phone: string
  network: "MTN" | "Telecel" | "AirtelTigo"
  size_gb: number
}

export interface MTNOrderResponse {
  success: boolean
  order_id?: number
  message: string
}

export interface MTNWebhookPayload {
  event: string
  timestamp: string
  order: {
    id: number
    status: "completed" | "failed" | "pending"
    message: string
    amount: number
    recipient_phone: string
    plan_name: string
    network: string
    size_mb: number
    created_at: string
    updated_at: string
  }
  user?: {
    name: string
    phone: string
  }
}

const MTN_API_KEY = process.env.MTN_API_KEY || ""
const MTN_API_BASE_URL = process.env.MTN_API_BASE_URL || "https://sykesofficial.net"
const REQUEST_TIMEOUT = 30000 // 30 seconds

// MTN phone number prefixes by network
const MTN_PREFIXES = ["024", "025", "053", "054", "055", "059"]
const TELECEL_PREFIXES = ["020", "050"]
const AIRTELTIGO_PREFIXES = ["026", "027", "056", "057"]

/**
 * Normalize phone number to standard format (0XXXXXXXXXX)
 */
export function normalizePhoneNumber(phone: string): string {
  // Remove all non-digit characters
  let normalized = phone.replace(/\D/g, "")

  // If it starts with 233 (country code), replace with 0
  if (normalized.startsWith("233")) {
    normalized = "0" + normalized.substring(3)
  }

  // If no leading 0, add it
  if (!normalized.startsWith("0")) {
    normalized = "0" + normalized
  }

  return normalized
}

/**
 * Validate phone number format
 */
export function isValidPhoneFormat(phone: string): boolean {
  const normalized = normalizePhoneNumber(phone)

  // Must be 10 digits starting with 0
  if (!/^0\d{9}$/.test(normalized)) {
    return false
  }

  return true
}

/**
 * Get network from phone number
 */
export function getNetworkFromPhone(phone: string): "MTN" | "Telecel" | "AirtelTigo" | null {
  const normalized = normalizePhoneNumber(phone)
  const prefix = normalized.substring(0, 3)

  if (MTN_PREFIXES.includes(prefix)) return "MTN"
  if (TELECEL_PREFIXES.includes(prefix)) return "Telecel"
  if (AIRTELTIGO_PREFIXES.includes(prefix)) return "AirtelTigo"

  return null
}

/**
 * Validate if phone number matches network
 */
export function validatePhoneNetworkMatch(
  phone: string,
  network: "MTN" | "Telecel" | "AirtelTigo"
): boolean {
  const detectedNetwork = getNetworkFromPhone(phone)
  return detectedNetwork === network
}

/**
 * Check if MTN auto-fulfillment is enabled
 */
export async function isAutoFulfillmentEnabled(): Promise<boolean> {
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "mtn_auto_fulfillment_enabled")
      .single()

    return data?.value === "true"
  } catch (error) {
    console.error("[MTN] Error checking auto-fulfillment setting:", error)
    return false
  }
}

/**
 * Set MTN auto-fulfillment status
 */
export async function setAutoFulfillmentEnabled(enabled: boolean): Promise<boolean> {
  try {
    const { error } = await supabase
      .from("app_settings")
      .update({
        value: enabled ? "true" : "false",
        updated_at: new Date().toISOString(),
      })
      .eq("key", "mtn_auto_fulfillment_enabled")

    if (error) throw error
    return true
  } catch (error) {
    console.error("[MTN] Error setting auto-fulfillment:", error)
    return false
  }
}

/**
 * Get MTN wallet balance
 */
export async function checkMTNBalance(): Promise<number | null> {
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
      throw new Error(`MTN API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    
    // Assuming API returns { success: true, balance: 1000.50 }
    if (data.success && typeof data.balance === "number") {
      return data.balance
    }

    return null
  } catch (error) {
    console.error("[MTN] Error checking balance:", error)
    return null
  }
}

/**
 * Create order via MTN API
 */
export async function createMTNOrder(order: MTNOrderRequest): Promise<MTNOrderResponse> {
  try {
    // Validate inputs
    if (!isValidPhoneFormat(order.recipient_phone)) {
      return {
        success: false,
        message: `Invalid phone number format: ${order.recipient_phone}`,
      }
    }

    if (!validatePhoneNetworkMatch(order.recipient_phone, order.network)) {
      return {
        success: false,
        message: `Phone number does not match ${order.network} network`,
      }
    }

    const normalized_phone = normalizePhoneNumber(order.recipient_phone)

    // Check balance first
    const balance = await checkMTNBalance()
    if (balance === null) {
      return {
        success: false,
        message: "Unable to verify balance. Please try again.",
      }
    }

    // Make API call
    const response = await fetch(`${MTN_API_BASE_URL}/api/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": MTN_API_KEY,
      },
      body: JSON.stringify({
        recipient_phone: normalized_phone,
        network: order.network,
        size_gb: order.size_gb,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })

    const data = (await response.json()) as MTNOrderResponse

    if (!response.ok) {
      console.error("[MTN] API error response:", data)
      return {
        success: false,
        message: data.message || `API returned ${response.status}`,
      }
    }

    return data
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("[MTN] Error creating order:", message)

    return {
      success: false,
      message: `Failed to create order: ${message}`,
    }
  }
}

/**
 * Verify webhook signature
 */
export function verifyWebhookSignature(payload: string, signature: string): boolean {
  try {
    const expectedSignature = crypto
      .createHmac("sha256", MTN_API_KEY)
      .update(payload)
      .digest("hex")

    return signature === `sha256=${expectedSignature}`
  } catch (error) {
    console.error("[MTN] Webhook signature verification error:", error)
    return false
  }
}

/**
 * Save MTN order to tracking table
 */
export async function saveMTNTracking(
  shopOrderId: string,
  mtnOrderId: number,
  request: MTNOrderRequest,
  response: MTNOrderResponse
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("mtn_fulfillment_tracking")
      .insert({
        shop_order_id: shopOrderId,
        mtn_order_id: mtnOrderId,
        status: "pending",
        recipient_phone: request.recipient_phone,
        network: request.network,
        size_gb: request.size_gb,
        api_request_payload: request,
        api_response_payload: response,
      })
      .select("id")
      .single()

    if (error) throw error
    return data?.id || null
  } catch (error) {
    console.error("[MTN] Error saving tracking:", error)
    return null
  }
}

/**
 * Update MTN order status from webhook
 */
export async function updateMTNOrderFromWebhook(
  webhook: MTNWebhookPayload
): Promise<boolean> {
  try {
    const mtnOrderId = webhook.order.id
    const newStatus =
      webhook.order.status === "completed"
        ? "completed"
        : webhook.order.status === "failed"
          ? "failed"
          : "pending"

    // Update tracking table
    const { error: trackingError } = await supabase
      .from("mtn_fulfillment_tracking")
      .update({
        status: newStatus,
        external_status: webhook.order.status,
        external_message: webhook.order.message,
        webhook_payload: webhook,
        webhook_received_at: new Date(webhook.timestamp),
      })
      .eq("mtn_order_id", mtnOrderId)

    if (trackingError) throw trackingError

    // Get the shop_order_id to update shop_orders table
    const { data: tracking } = await supabase
      .from("mtn_fulfillment_tracking")
      .select("shop_order_id")
      .eq("mtn_order_id", mtnOrderId)
      .single()

    if (!tracking) {
      console.warn(`[MTN] No tracking record found for MTN order ${mtnOrderId}`)
      return false
    }

    // Update shop_orders status
    const shopOrderStatus =
      newStatus === "completed"
        ? "completed"
        : newStatus === "failed"
          ? "failed"
          : "pending"

    const { error: shopError } = await supabase
      .from("shop_orders")
      .update({
        order_status: shopOrderStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("id", tracking.shop_order_id)

    if (shopError) throw shopError

    // Add fulfillment log
    const { error: logError } = await supabase
      .from("fulfillment_logs")
      .insert({
        order_id: tracking.shop_order_id,
        order_type: "shop",
        status: shopOrderStatus,
        external_api: "MTN",
        external_order_id: mtnOrderId,
        external_response: webhook.order,
        notes: webhook.order.message,
      })

    if (logError) console.error("[MTN] Error creating fulfillment log:", logError)

    return true
  } catch (error) {
    console.error("[MTN] Error updating order from webhook:", error)
    return false
  }
}

/**
 * Retry failed MTN order (with exponential backoff)
 */
export async function retryMTNOrder(
  trackingId: string,
  maxAttempts: number = 4
): Promise<boolean> {
  try {
    // Get tracking record
    const { data: tracking, error: fetchError } = await supabase
      .from("mtn_fulfillment_tracking")
      .select("*")
      .eq("id", trackingId)
      .single()

    if (fetchError || !tracking) {
      console.error("[MTN] Tracking record not found:", trackingId)
      return false
    }

    // Check retry count
    if (tracking.retry_count >= maxAttempts) {
      console.warn(
        `[MTN] Max retries (${maxAttempts}) exceeded for tracking ${trackingId}`
      )
      return false
    }

    // Retry the order
    const order: MTNOrderRequest = {
      recipient_phone: tracking.recipient_phone,
      network: tracking.network,
      size_gb: tracking.size_gb,
    }

    const result = await createMTNOrder(order)

    if (result.success && result.order_id) {
      // Update tracking with new MTN order ID
      const { error } = await supabase
        .from("mtn_fulfillment_tracking")
        .update({
          mtn_order_id: result.order_id,
          status: "pending",
          retry_count: tracking.retry_count + 1,
          last_retry_at: new Date().toISOString(),
          api_response_payload: result,
        })
        .eq("id", trackingId)

      if (error) throw error
      return true
    } else {
      // Update with error status
      const { error } = await supabase
        .from("mtn_fulfillment_tracking")
        .update({
          status: "retrying",
          retry_count: tracking.retry_count + 1,
          last_retry_at: new Date().toISOString(),
        })
        .eq("id", trackingId)

      if (error) throw error
      return false
    }
  } catch (error) {
    console.error("[MTN] Error retrying order:", error)
    return false
  }
}

/**
 * Get retry backoff time in milliseconds based on attempt number
 */
export function getRetryBackoffMs(attemptNumber: number): number {
  // Attempt 1: 5 minutes
  // Attempt 2: 15 minutes
  // Attempt 3: 1 hour
  // Attempt 4+: 24 hours (should escalate to manual review)
  const backoffs = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 24 * 60 * 60 * 1000]
  return backoffs[Math.min(attemptNumber, backoffs.length - 1)]
}
