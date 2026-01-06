import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"
import {
  verifyWebhookSignature,
  updateMTNOrderFromWebhook,
  MTNWebhookPayload,
} from "@/lib/mtn-fulfillment"
import {
  mtnConfig,
  log,
  generateTraceId,
  recordMetrics,
} from "@/lib/mtn-production-config"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// Webhook secret for additional verification
const WEBHOOK_SECRET = process.env.MTN_WEBHOOK_SECRET || mtnConfig.apiKey

/**
 * POST /api/webhooks/mtn
 * 
 * Handles incoming webhooks from MTN API.
 * Verifies signature, processes order status updates,
 * and sends customer notifications.
 */
export async function POST(request: NextRequest) {
  const traceId = generateTraceId()
  const startTime = Date.now()

  try {
    // Get raw body for signature verification
    const rawBody = await request.text()
    
    // Get signature from headers
    const signature = request.headers.get("x-webhook-signature") ||
      request.headers.get("x-signature") ||
      request.headers.get("signature")

    log("info", "Webhook", "Received webhook request", { traceId, hasSignature: !!signature })

    // Verify webhook signature
    if (signature) {
      const isValid = verifyWebhookSignature(rawBody, signature)
      if (!isValid) {
        log("warn", "Webhook", "Invalid webhook signature", { traceId })
        return NextResponse.json(
          { error: "Invalid signature", traceId },
          { status: 401 }
        )
      }
      log("debug", "Webhook", "Signature verified", { traceId })
    } else {
      // In production, signature should be required
      if (process.env.NODE_ENV === "production") {
        log("warn", "Webhook", "Missing webhook signature in production", { traceId })
        return NextResponse.json(
          { error: "Missing signature", traceId },
          { status: 401 }
        )
      }
      log("warn", "Webhook", "No signature provided (development mode)", { traceId })
    }

    // Parse webhook payload
    let payload: MTNWebhookPayload
    try {
      payload = JSON.parse(rawBody)
    } catch (parseError) {
      log("error", "Webhook", "Failed to parse webhook payload", { traceId, error: String(parseError) })
      return NextResponse.json(
        { error: "Invalid JSON payload", traceId },
        { status: 400 }
      )
    }

    // Validate required fields
    if (!payload.event || !payload.order?.id) {
      log("error", "Webhook", "Missing required webhook fields", { traceId, payload })
      return NextResponse.json(
        { error: "Missing required fields", traceId },
        { status: 400 }
      )
    }

    log("info", "Webhook", `Processing ${payload.event} event`, {
      traceId,
      mtnOrderId: payload.order.id,
      status: payload.order.status,
    })

    // Store webhook for audit
    await storeWebhookEvent(traceId, payload, rawBody)

    // Handle different event types
    switch (payload.event) {
      case "order.completed":
      case "order.success":
        await handleOrderCompleted(traceId, payload)
        break

      case "order.failed":
      case "order.error":
        await handleOrderFailed(traceId, payload)
        break

      case "order.pending":
      case "order.processing":
        await handleOrderPending(traceId, payload)
        break

      default:
        log("warn", "Webhook", `Unknown event type: ${payload.event}`, { traceId })
    }

    const latency = Date.now() - startTime
    recordMetrics(true, latency)

    log("info", "Webhook", "Webhook processed successfully", { traceId, latencyMs: latency })

    return NextResponse.json({
      success: true,
      message: "Webhook processed",
      traceId,
    })
  } catch (error) {
    const latency = Date.now() - startTime
    recordMetrics(false, latency)

    log("error", "Webhook", "Webhook processing failed", {
      traceId,
      error: error instanceof Error ? error.message : String(error),
    })

    return NextResponse.json(
      {
        error: "Webhook processing failed",
        traceId,
        details: error instanceof Error ? error.message : undefined,
      },
      { status: 500 }
    )
  }
}

/**
 * Store webhook event for audit trail
 */
async function storeWebhookEvent(
  traceId: string,
  payload: MTNWebhookPayload,
  rawBody: string
): Promise<void> {
  try {
    await supabase.from("mtn_webhook_events").insert({
      trace_id: traceId,
      event_type: payload.event,
      mtn_order_id: payload.order.id,
      payload: payload,
      raw_body: rawBody,
      received_at: new Date().toISOString(),
    })
  } catch (error) {
    // Non-critical - log but don't fail
    log("warn", "Webhook", "Failed to store webhook event", { traceId, error: String(error) })
  }
}

/**
 * Handle successful order completion
 */
async function handleOrderCompleted(
  traceId: string,
  payload: MTNWebhookPayload
): Promise<void> {
  const { order } = payload

  // Update order status in database
  const updated = await updateMTNOrderFromWebhook(payload)
  if (!updated) {
    log("error", "Webhook", "Failed to update order from webhook", { traceId, mtnOrderId: order.id })
    return
  }

  // Get order details for notification
  const { data: tracking } = await supabase
    .from("mtn_fulfillment_tracking")
    .select("shop_order_id, recipient_phone")
    .eq("mtn_order_id", order.id)
    .single()

  if (tracking) {
    // Send success SMS to customer
    try {
      const sizeMB = order.size_mb
      const sizeDisplay = sizeMB >= 1000 ? `${(sizeMB / 1000).toFixed(1)}GB` : `${sizeMB}MB`

      await sendSMS({
        phone: tracking.recipient_phone,
        message: SMSTemplates.orderDelivered(order.id.toString()),
        type: "order_delivered",
      })
      log("info", "Webhook", "Sent success SMS", { traceId, phone: tracking.recipient_phone })
    } catch (smsError) {
      log("warn", "Webhook", "Failed to send success SMS", { traceId, error: String(smsError) })
    }

    // Update shop_orders
    await supabase
      .from("shop_orders")
      .update({
        order_status: "completed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", tracking.shop_order_id)

    // Update profit tracking if needed
    await updateProfitOnCompletion(tracking.shop_order_id)
  }

  log("info", "Webhook", "Order completed successfully", { traceId, mtnOrderId: order.id })
}

/**
 * Handle failed order
 */
async function handleOrderFailed(
  traceId: string,
  payload: MTNWebhookPayload
): Promise<void> {
  const { order } = payload

  // Update order status in database
  await updateMTNOrderFromWebhook(payload)

  // Get order details for notification
  const { data: tracking } = await supabase
    .from("mtn_fulfillment_tracking")
    .select("shop_order_id, recipient_phone, retry_count")
    .eq("mtn_order_id", order.id)
    .single()

  if (tracking) {
    // Update shop_orders
    await supabase
      .from("shop_orders")
      .update({
        order_status: "failed",
        failure_reason: order.message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", tracking.shop_order_id)

    // Send failure SMS to customer
    try {
      await sendSMS({
        phone: tracking.recipient_phone,
        message: SMSTemplates.fulfillmentFailed(
          tracking.shop_order_id.substring(0, 8),
          tracking.recipient_phone,
          order.network,
          (order.size_mb / 1000).toString(),
          order.message || "Order could not be processed"
        ),
        type: "fulfillment_failed",
      })
      log("info", "Webhook", "Sent failure SMS", { traceId, phone: tracking.recipient_phone })
    } catch (smsError) {
      log("warn", "Webhook", "Failed to send failure SMS", { traceId, error: String(smsError) })
    }

    // Check if eligible for retry
    if (tracking.retry_count < mtnConfig.maxRetries) {
      await supabase
        .from("mtn_fulfillment_tracking")
        .update({
          status: "pending_retry",
          updated_at: new Date().toISOString(),
        })
        .eq("mtn_order_id", order.id)

      log("info", "Webhook", "Order marked for retry", {
        traceId,
        mtnOrderId: order.id,
        retryCount: tracking.retry_count,
      })
    }
  }

  log("warn", "Webhook", "Order failed", { traceId, mtnOrderId: order.id, reason: order.message })
}

/**
 * Handle pending/processing order
 */
async function handleOrderPending(
  traceId: string,
  payload: MTNWebhookPayload
): Promise<void> {
  const { order } = payload

  // Just update tracking status
  await supabase
    .from("mtn_fulfillment_tracking")
    .update({
      status: "processing",
      external_status: order.status,
      external_message: order.message,
      updated_at: new Date().toISOString(),
    })
    .eq("mtn_order_id", order.id)

  log("info", "Webhook", "Order status updated to pending/processing", {
    traceId,
    mtnOrderId: order.id,
  })
}

/**
 * Update profit tracking on order completion
 */
async function updateProfitOnCompletion(shopOrderId: string): Promise<void> {
  try {
    // Get order details
    const { data: order } = await supabase
      .from("shop_orders")
      .select("shop_id, profit_amount")
      .eq("id", shopOrderId)
      .single()

    if (!order || !order.profit_amount) return

    // Update shop_profits
    const { data: existing } = await supabase
      .from("shop_profits")
      .select("id, total_profit")
      .eq("shop_id", order.shop_id)
      .single()

    if (existing) {
      await supabase
        .from("shop_profits")
        .update({
          total_profit: existing.total_profit + order.profit_amount,
          last_order_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
    } else {
      await supabase.from("shop_profits").insert({
        shop_id: order.shop_id,
        total_profit: order.profit_amount,
        last_order_at: new Date().toISOString(),
      })
    }
  } catch (error) {
    log("warn", "Webhook", "Failed to update profit tracking", { error: String(error) })
  }
}

/**
 * GET /api/webhooks/mtn
 * 
 * Webhook verification endpoint (for MTN API registration).
 * Some webhook providers send a GET request to verify the endpoint.
 */
export async function GET(request: NextRequest) {
  const challenge = request.nextUrl.searchParams.get("challenge") ||
    request.nextUrl.searchParams.get("hub.challenge")

  if (challenge) {
    // Return challenge for webhook verification
    return new NextResponse(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })
  }

  return NextResponse.json({
    status: "ok",
    endpoint: "MTN Webhook Handler",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  })
}
