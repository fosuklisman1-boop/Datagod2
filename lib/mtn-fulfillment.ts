import { supabaseAdmin as supabase } from "@/lib/supabase"
import crypto from "crypto"
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
  provider?: string // Which provider was used: "sykes" or "datakazina"
}

export interface MTNWebhookPayload {
  event: string
  timestamp: string
  order: {
    id: number
    status: "pending" | "processing" | "completed" | "failed"
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

// Use production config
const MTN_API_KEY = mtnConfig.apiKey
const MTN_API_BASE_URL = mtnConfig.apiBaseUrl
const REQUEST_TIMEOUT = mtnConfig.requestTimeout

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
    const { data, error } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "mtn_auto_fulfillment_enabled")
      .maybeSingle()

    if (error) {
      console.error("[MTN] Error checking auto-fulfillment setting:", error)
      return false
    }

    // If setting doesn't exist, default to false
    if (!data) {
      console.log("[MTN] Auto-fulfillment setting not found, defaulting to false")
      return false
    }

    // Extract enabled value from JSON object
    const isEnabled = data.value?.enabled === true
    console.log(`[MTN] Auto-fulfillment enabled: ${isEnabled}`)
    return isEnabled
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
    // Use upsert to create or update the setting
    const { error } = await supabase
      .from("admin_settings")
      .upsert({
        key: "mtn_auto_fulfillment_enabled",
        value: { enabled },
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "key",
      })

    if (error) {
      console.error("[MTN] Upsert error:", error)
      throw error
    }

    console.log(`[MTN] Auto-fulfillment set to: ${enabled}`)
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

    // Get raw response text (API sometimes returns PHP warnings before JSON)
    const responseText = await response.text()

    // Extract JSON from response (strip any PHP warnings/HTML before the JSON)
    let data: Record<string, unknown>
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[0])
      } else {
        console.warn("[MTN] No JSON found in balance response:", responseText.slice(0, 500))
        return null
      }
    } catch {
      console.warn("[MTN] Failed to parse balance response:", responseText.slice(0, 500))
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

    console.warn("[MTN] Unexpected balance response format:", data)
    return null
  } catch (error) {
    console.error("[MTN] Error checking balance:", error)
    return null
  }
}

/**
 * Create order via MTN API (Production-ready with provider abstraction)
 * 
 * This function now uses the provider factory to select between Sykes and DataKazina
 * based on admin settings, while maintaining backward compatibility.
 */
export async function createMTNOrder(order: MTNOrderRequest): Promise<MTNOrderResponse> {
  const { getMTNProvider } = await import("@/lib/mtn-providers/factory")

  try {
    // Get the selected provider (Sykes or DataKazina)
    const provider = await getMTNProvider()

    console.log(`[MTN] Creating order with provider: ${provider.name}`)

    // Call the provider's createOrder method
    const response = await provider.createOrder(order)

    // Return the response with provider name included
    return {
      ...response,
      provider: provider.name
    }
  } catch (error) {
    console.error("[MTN] Error in createMTNOrder:", error)

    return {
      success: false,
      message: error instanceof Error ? error.message : "Failed to create order",
      traceId: order.traceId,
      error_type: "SYSTEM_ERROR",
    }
  }
}

/**
 * LEGACY: Old createMTNOrder implementation using Sykes directly
 * This is kept for reference but is no longer used
 */
async function _legacyCreateMTNOrderSykes(order: MTNOrderRequest): Promise<MTNOrderResponse> {
  const traceId = order.traceId || generateTraceId()
  const startTime = Date.now()

  try {
    log("info", "Order", "Creating MTN order", {
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
    log("debug", "Order", "Calling MTN API", { traceId })
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
        log("error", "Order", "No JSON found in API response", { traceId, responseText: responseText.slice(0, 500) })
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
      log("error", "Order", "Failed to parse API response", { traceId, responseText: responseText.slice(0, 500), parseError })
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
      log("error", "Order", "MTN API HTTP error", { traceId, status: response.status, data })
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
      log("error", "Order", "MTN API returned error in response", { traceId, data })
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
    log("info", "Order", "MTN order created successfully", {
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

    log("error", "Order", "Error creating MTN order", {
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
 * Check MTN order status from Sykes API
 * Fetches all orders and finds the matching one by ID
 */
export async function checkMTNOrderStatus(mtnOrderId: number): Promise<{
  success: boolean
  status?: "pending" | "processing" | "completed" | "failed"
  message: string
  order?: MTNWebhookPayload["order"]
}> {
  const traceId = generateTraceId()

  try {
    log("info", "StatusCheck", `Checking status for MTN order ${mtnOrderId}`, { traceId, mtnOrderId })

    // The Sykes API GET /api/orders returns all orders, not a single one
    // So we fetch all orders and filter for the one we need
    // Use limit=5000 to get all orders (API defaults to only 20)
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

    // Handle various response formats:
    // 1. Array of orders: [{id, status, ...}]
    // 2. Single order wrapped: {order: {id, status, ...}}
    // 3. Direct order object: {id, status, ...}
    // 4. Data wrapper: {data: [{id, status, ...}]}
    // 5. Orders wrapper: {orders: [{id, status, ...}]}
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

    // Find the order by ID (handle both string and number comparison)
    if (!order && allOrders.length > 0) {
      // Try exact match first
      order = allOrders.find((o: any) => o.id === mtnOrderId || o.id === String(mtnOrderId) || String(o.id) === String(mtnOrderId))

      if (!order) {
        // Try matching order_id field as well
        order = allOrders.find((o: any) => o.order_id === mtnOrderId || o.order_id === String(mtnOrderId) || String(o.order_id) === String(mtnOrderId))
      }

      if (!order) {
        console.log(`[MTN-STATUS] Order ${mtnOrderId} not found in ${allOrders.length} orders. Available IDs: ${allOrders.map((o: any) => o.id || o.order_id).slice(0, 10).join(', ')}`)
        return {
          success: false,
          message: `Order ${mtnOrderId} not found in API response (${allOrders.length} orders returned)`,
        }
      }
    }

    if (!order || !order.status) {
      console.log(`[MTN-STATUS] Order or status not found. Order:`, order, `Data:`, JSON.stringify(data).slice(0, 300))
      return {
        success: false,
        message: `Order not found or no status. Response: ${JSON.stringify(data).slice(0, 200)}`,
      }
    }

    // Log the raw status for debugging
    console.log(`[MTN-STATUS] Raw API status for order ${mtnOrderId}: "${order.status}" (type: ${typeof order.status})`)

    // Normalize status from API to our expected values
    let normalizedStatus: "pending" | "processing" | "completed" | "failed" = "pending"
    const apiStatus = String(order.status).toLowerCase().trim()

    // Completed status variations
    if (apiStatus === "completed" || apiStatus === "success" || apiStatus === "delivered" ||
      apiStatus === "done" || apiStatus === "fulfilled" || apiStatus === "sent" ||
      apiStatus === "successful" || apiStatus === "complete") {
      normalizedStatus = "completed"
    }
    // Failed status variations
    else if (apiStatus === "failed" || apiStatus === "error" || apiStatus === "cancelled" ||
      apiStatus === "rejected" || apiStatus === "expired" || apiStatus === "refunded") {
      normalizedStatus = "failed"
    }
    // Processing status variations
    else if (apiStatus === "processing" || apiStatus === "in_progress" || apiStatus === "queued" ||
      apiStatus === "in-progress" || apiStatus === "sending" || apiStatus === "submitted") {
      normalizedStatus = "processing"
    }
    // Pending status
    else if (apiStatus === "pending" || apiStatus === "waiting" || apiStatus === "new") {
      normalizedStatus = "pending"
    }
    // Unknown status - log it clearly
    else {
      console.warn(`[MTN-STATUS] ⚠️ UNKNOWN API status: "${order.status}" for order ${mtnOrderId} - defaulting to processing`)
      log("warn", "StatusCheck", `Unknown API status: ${order.status}, defaulting to processing`, { traceId })
      normalizedStatus = "processing"
    }

    console.log(`[MTN-STATUS] Normalized: "${order.status}" -> "${normalizedStatus}"`)
    log("info", "StatusCheck", `Status normalized: ${order.status} -> ${normalizedStatus}`, { traceId })

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
 * Sync MTN order status from API and update local tracking
 */
export async function syncMTNOrderStatus(trackingId: string): Promise<{
  success: boolean
  newStatus?: string
  message: string
}> {
  try {
    // Get tracking record
    const { data: tracking, error: fetchError } = await supabase
      .from("mtn_fulfillment_tracking")
      .select("*")
      .eq("id", trackingId)
      .single()

    if (fetchError || !tracking) {
      return { success: false, message: "Tracking record not found" }
    }

    if (!tracking.mtn_order_id) {
      return { success: false, message: "No MTN order ID in tracking record" }
    }

    console.log(`[MTN-SYNC] Checking status for order ${tracking.mtn_order_id}, current status: ${tracking.status}`)

    // Check status from API
    const statusResult = await checkMTNOrderStatus(tracking.mtn_order_id)

    console.log(`[MTN-SYNC] API result:`, JSON.stringify(statusResult))

    if (!statusResult.success || !statusResult.status) {
      console.log(`[MTN-SYNC] API check failed, NOT updating status`)
      return { success: false, message: statusResult.message }
    }

    // Prevent status regression: don't go from processing/completed back to pending
    const statusPriority: Record<string, number> = {
      "pending": 1,
      "processing": 2,
      "completed": 3,
      "failed": 3,
    }

    const currentPriority = statusPriority[tracking.status] || 0
    const newPriority = statusPriority[statusResult.status] || 0

    if (newPriority < currentPriority) {
      console.log(`[MTN-SYNC] Preventing status regression: ${tracking.status} -> ${statusResult.status} (blocked)`)
      return {
        success: true,
        newStatus: tracking.status,
        message: `Status not updated (would regress from ${tracking.status} to ${statusResult.status})`
      }
    }

    // If status changed, update tracking and shop order
    if (statusResult.status !== tracking.status) {
      const newStatus = statusResult.status

      console.log(`[MTN-SYNC] Updating status: ${tracking.status} -> ${newStatus}`)

      // Update tracking
      const { error: trackingUpdateError } = await supabase
        .from("mtn_fulfillment_tracking")
        .update({
          status: newStatus,
          external_status: statusResult.order?.status,
          external_message: statusResult.order?.message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", trackingId)

      if (trackingUpdateError) {
        console.error(`[MTN-SYNC] Failed to update tracking:`, trackingUpdateError)
        return { success: false, message: `Failed to update tracking: ${trackingUpdateError.message}` }
      }

      // Update shop_orders if completed or failed
      if (tracking.shop_order_id && (newStatus === "completed" || newStatus === "failed")) {
        console.log(`[MTN-SYNC] Updating shop_order ${tracking.shop_order_id} to ${newStatus}`)
        const { error: shopOrderError } = await supabase
          .from("shop_orders")
          .update({
            order_status: newStatus,
            updated_at: new Date().toISOString(),
          })
          .eq("id", tracking.shop_order_id)

        if (shopOrderError) {
          console.error(`[MTN-SYNC] Failed to update shop_order:`, shopOrderError)
        } else {
          console.log(`[MTN-SYNC] ✅ Updated shop_order ${tracking.shop_order_id} to ${newStatus}`)
        }
      }

      // Update orders table if bulk order
      if (tracking.order_id && (newStatus === "completed" || newStatus === "failed")) {
        console.log(`[MTN-SYNC] Updating bulk order ${tracking.order_id} to ${newStatus}`)
        const { error: orderError } = await supabase
          .from("orders")
          .update({
            status: newStatus,
            updated_at: new Date().toISOString(),
          })
          .eq("id", tracking.order_id)

        if (orderError) {
          console.error(`[MTN-SYNC] Failed to update order:`, orderError)
        } else {
          console.log(`[MTN-SYNC] ✅ Updated order ${tracking.order_id} to ${newStatus}`)
        }
      }

      console.log(`[MTN] Synced order ${tracking.mtn_order_id} status: ${tracking.status} -> ${newStatus}`)
      return { success: true, newStatus, message: `Status updated to ${newStatus}` }
    }

    return { success: true, newStatus: tracking.status, message: "Status unchanged" }
  } catch (error) {
    console.error("[MTN] Error syncing order status:", error)
    return { success: false, message: error instanceof Error ? error.message : "Sync failed" }
  }
}

/**
 * Save MTN order to tracking table
 * @param orderId - The order ID (either from shop_orders or orders table)
 * @param mtnOrderId - The MTN order ID from the API response
 * @param request - The MTN order request
 * @param response - The MTN order response
 * @param orderType - 'shop' for storefront orders, 'bulk' for data package orders
 * @param provider - The MTN provider used (sykes, datakazina)
 */
export async function saveMTNTracking(
  orderId: string,
  mtnOrderId: number | string,
  request: MTNOrderRequest,
  response: MTNOrderResponse,
  orderType: "shop" | "bulk" = "shop",
  provider: string = "sykes"
): Promise<string | null> {
  try {
    // Build insert data based on order type
    // Set status to "pending" - the cron job will sync the actual status from provider
    const insertData: Record<string, unknown> = {
      mtn_order_id: mtnOrderId,
      status: "pending",
      recipient_phone: request.recipient_phone,
      network: request.network,
      size_gb: request.size_gb,
      api_request_payload: request,
      api_response_payload: response,
      order_type: orderType,
      provider, // Track which provider was used
    }

    // Set the appropriate order ID column based on type
    if (orderType === "shop") {
      insertData.shop_order_id = orderId
    } else {
      insertData.order_id = orderId
    }

    const { data, error } = await supabase
      .from("mtn_fulfillment_tracking")
      .insert(insertData)
      .select("id")
      .single()

    if (error) throw error
    console.log(`[MTN] Tracking record created: ${data?.id} for ${orderType} order ${orderId} (provider: ${provider})`)
    return data?.id || null
  } catch (error) {
    console.error("[MTN] Error saving tracking:", error)
    return null
  }
}

/**
 * Update MTN order status from webhook
 * Updates both mtn_fulfillment_tracking and the corresponding order table (shop_orders or orders)
 */
export async function updateMTNOrderFromWebhook(
  webhook: MTNWebhookPayload
): Promise<boolean> {
  try {
    const mtnOrderId = webhook.order.id
    // Map API status to our status - include "processing"
    const newStatus =
      webhook.order.status === "completed"
        ? "completed"
        : webhook.order.status === "failed"
          ? "failed"
          : webhook.order.status === "processing"
            ? "processing"
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
        updated_at: new Date().toISOString(),
      })
      .eq("mtn_order_id", mtnOrderId)

    if (trackingError) throw trackingError

    // Get the tracking record to update the corresponding order table
    const { data: tracking } = await supabase
      .from("mtn_fulfillment_tracking")
      .select("shop_order_id, order_id, order_type")
      .eq("mtn_order_id", mtnOrderId)
      .single()

    if (!tracking) {
      console.warn(`[MTN] No tracking record found for MTN order ${mtnOrderId}`)
      return false
    }

    // Update the corresponding order table based on order_type
    if (tracking.order_type === "bulk" && tracking.order_id) {
      // Update bulk orders table
      const { error: orderError } = await supabase
        .from("orders")
        .update({
          status: newStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tracking.order_id)

      if (orderError) {
        console.error("[MTN] Error updating bulk order:", orderError)
      } else {
        console.log(`[MTN] Updated bulk order ${tracking.order_id} status to ${newStatus}`)
      }
    } else if (tracking.shop_order_id) {
      // Update shop_orders table
      const { error: shopError } = await supabase
        .from("shop_orders")
        .update({
          order_status: newStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tracking.shop_order_id)

      if (shopError) {
        console.error("[MTN] Error updating shop order:", shopError)
      } else {
        console.log(`[MTN] Updated shop order ${tracking.shop_order_id} status to ${newStatus}`)
      }
    }

    // Add fulfillment log
    const { error: logError } = await supabase
      .from("fulfillment_logs")
      .insert({
        order_id: tracking.shop_order_id || tracking.order_id,
        order_type: tracking.order_type || "shop",
        status: newStatus,
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
