import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"
import {
  verifyWebhookSignature,
  updateMTNOrderFromWebhook,
  updateDataKazinaOrderFromPayload,
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
    const contentType = request.headers.get("content-type") || ""
    
    // Log headers (excluding potentially sensitive ones like authorization)
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      if (!key.match(/auth|key|cookie|token/i)) {
        headers[key] = value
      }
    })

    // Get signature from headers
    const signature = request.headers.get("x-webhook-signature") ||
      request.headers.get("x-signature") ||
      request.headers.get("signature")

    log("info", "Webhook", "Received webhook request", { traceId, hasSignature: !!signature, contentType, headers })

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
    } else if (process.env.NODE_ENV === "production") {
      log("warn", "Webhook", "Missing webhook signature in production", { traceId })
      return NextResponse.json(
        { error: "Missing signature", traceId },
        { status: 401 }
      )
    }

    // Parse webhook payload
    let payload: MTNWebhookPayload | null = null
    
    try {
      if (contentType.includes("application/json")) {
        payload = JSON.parse(rawBody)
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        // Handle form-encoded payload (sometimes used by legacy systems)
        const params = new URLSearchParams(rawBody)
        const obj: any = {}
        params.forEach((value, key) => {
          // Attempt to parse nested fields if they look like JSON
          try {
            if (value.startsWith("{") || value.startsWith("[")) {
              obj[key] = JSON.parse(value)
            } else {
              obj[key] = value
            }
          } catch {
            obj[key] = value
          }
        })
        payload = obj as MTNWebhookPayload
      } else {
        // Fallback: try JSON anyway if content-type is missing or generic
        payload = JSON.parse(rawBody)
      }
    } catch (parseError) {
      log("error", "Webhook", "Failed to parse webhook payload", { 
        traceId, 
        error: String(parseError),
        contentType,
        bodyPrefix: rawBody.substring(0, 200)
      })
      
      // Still audit the raw attempt
      await storeWebhookEvent(traceId, { event: "parse_error" } as any, rawBody)
      
      return NextResponse.json(
        { 
          error: "Invalid payload format", 
          details: String(parseError),
          contentType,
          traceId 
        },
        { status: 400 }
      )
    }

    if (!payload) {
        return NextResponse.json({ error: "Empty payload", traceId }, { status: 400 })
    }

    // Store webhook for audit immediately
    await storeWebhookEvent(traceId, payload, rawBody)

    // Normalized event detection for provider-agnostic handling
    const eventType = payload.event || (payload as any).type || (payload as any).event_type
    const isTest = (payload.event === "ping" || payload.event === "test" || (payload as any).type === "test_event" || (payload as any).test === true)

    // Check if it's a test/ping webhook from the dashboard
    if (isTest) {
      log("info", "Webhook", "Received test/ping webhook", { traceId, provider: payload.order ? "Sykes" : "DataKazina", payload })
      return NextResponse.json({ success: true, message: "Webhook endpoint tested successfully", event: eventType })
    }

    // Determine the MTN order ID for logging (handle Sykes, DataKazina, and common fallbacks)
    const mtnOrderId = payload.order?.id || 
                      (payload as any).id || 
                      (payload as any).order_code || 
                      (payload as any).transaction_id || 
                      (payload as any).reference
    
    if (!eventType || !mtnOrderId) {
      log("warn", "Webhook", "Missing required webhook fields", { traceId, payload })
      return NextResponse.json(
        { 
          error: "Missing required fields", 
          details: "Could not identify 'event'/'type' or an Order ID", 
          received_payload: payload,
          traceId 
        },
        { status: 400 }
      )
    }

    // DETECT PROVIDER AND ROUTE
    // Sykes: Has an "order" object
    // DataKazina: Has "order_code" or "transaction_id" at top level
    const isSykes = !!payload.order
    const isDataKazina = !!(payload as any).order_code || !!(payload as any).transaction_id || (!!(payload as any).type && !isSykes)

    log("info", "Webhook", `Processing ${eventType} event`, {
      traceId,
      provider: isSykes ? "Sykes" : isDataKazina ? "DataKazina" : "Unknown",
      mtnOrderId,
      status: payload.order?.status || (payload as any).status,
    })

    // Handle updates based on detected provider
    let updateSuccess = false
    if (isSykes) {
      updateSuccess = await updateMTNOrderFromWebhook(payload)
    } else if (isDataKazina) {
      updateSuccess = await updateDataKazinaOrderFromPayload(payload as any)
    } else {
      log("warn", "Webhook", "Unknown provider format, attempting generic update", { traceId })
      // Try both as a fallback
      updateSuccess = await updateMTNOrderFromWebhook(payload) || await updateDataKazinaOrderFromPayload(payload as any)
    }

    if (!updateSuccess) {
       log("warn", "Webhook", "Order update failed (record might not exist yet)", { traceId, mtnOrderId })
    }

    // Trigger specific logic for status changes (notifications, etc.)
    const status = (payload.order?.status || (payload as any).status || "").toLowerCase()

    if (eventType === "order.status_changed" || eventType === "status_changed") {
      if (status === "completed" || status === "delivered" || status === "success") {
        await handleOrderCompleted(traceId, payload)
      } else if (status === "failed" || status === "error" || status === "rejected") {
        await handleOrderFailed(traceId, payload)
      } else if (status === "processing") {
        await handleOrderProcessing(traceId, payload)
      } else if (status === "pending") {
        await handleOrderPending(traceId, payload)
      }
    } else if (eventType.includes("completed") || eventType.includes("success")) {
      await handleOrderCompleted(traceId, payload)
    } else if (eventType.includes("failed") || eventType.includes("error")) {
      await handleOrderFailed(traceId, payload)
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
      event_type: payload.event || "unknown",
      mtn_order_id: payload.order?.id || (payload as any).order_id || (payload as any).transaction_id || null,
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

  // Update order status in database (updates both tracking and order tables)
  const updated = await updateMTNOrderFromWebhook(payload)
  if (!updated) {
    log("error", "Webhook", "Failed to update order from webhook", { traceId, mtnOrderId: order.id })
    return
  }

  // Get order details for notification and profit update
  const { data: tracking } = await supabase
    .from("mtn_fulfillment_tracking")
    .select("shop_order_id, order_id, order_type, recipient_phone")
    .eq("mtn_order_id", order.id)
    .single()

  if (tracking) {
    // No customer SMS on delivery — email only

    // Send success Email
    try {
      let emailAddress: string | undefined;
      let customerName: string | undefined;

      if (tracking.shop_order_id) {
        const { data: so } = await supabase.from('shop_orders').select('customer_email, customer_name').eq('id', tracking.shop_order_id).single();
        if (so?.customer_email) { emailAddress = so.customer_email; customerName = so.customer_name; }
      } else if (tracking.order_id) {
        const { data: o } = await supabase.from('orders').select('user_id').eq('id', tracking.order_id).single();
        if (o?.user_id) {
          const { data: u } = await supabase.from('users').select('email, first_name').eq('id', o.user_id).single();
          if (u?.email) { emailAddress = u.email; customerName = u.first_name; }
        }
      }

      if (emailAddress) {
        const { sendEmail, EmailTemplates } = await import("@/lib/email-service");
        const payload = EmailTemplates.orderDelivered(
          order.id.toString(),
          order.network || "MTN",
          (order.size_mb / 1000).toFixed(1)
        );
        await sendEmail({
          to: [{ email: emailAddress, name: customerName }],
          subject: payload.subject,
          htmlContent: (payload as any).htmlContent || payload.html,
          referenceId: order.id.toString(),
          type: 'order_delivered'
        });
        log("info", "Webhook", "Sent success Email", { traceId, email: emailAddress });
      }
    } catch (emailError) {
      log("warn", "Webhook", "Failed to send success Email", { traceId, error: String(emailError) });
    }

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

  // Update order status in database (updates both tracking and order tables)
  await updateMTNOrderFromWebhook(payload)

  // Get order details for notification
  const { data: tracking } = await supabase
    .from("mtn_fulfillment_tracking")
    .select("shop_order_id, order_id, order_type, recipient_phone, retry_count")
    .eq("mtn_order_id", order.id)
    .single()

  if (tracking) {
    // Notify admins only of failure (not customer)
    try {
      const orderId = tracking.shop_order_id || tracking.order_id || order.id.toString()
      const { notifyAdmins } = await import("@/lib/sms-service")
      await notifyAdmins(
        SMSTemplates.fulfillmentFailed(
          orderId.substring(0, 8),
          tracking.recipient_phone,
          order.network,
          (order.size_mb / 1000).toString(),
          order.message || "Order could not be processed"
        ),
        "fulfillment_failure",
        orderId,
        true // skip email fallback — email is handled separately
      )
      log("info", "Webhook", "Notified admins of failure", { traceId })
    } catch (smsError) {
      log("warn", "Webhook", "Failed to notify admins of failure", { traceId, error: String(smsError) })
    }

    // Send failure Email
    try {
      let emailAddress: string | undefined;
      let customerName: string | undefined;

      if (tracking.shop_order_id) {
        const { data: so } = await supabase.from('shop_orders').select('customer_email, customer_name').eq('id', tracking.shop_order_id).single();
        if (so?.customer_email) { emailAddress = so.customer_email; customerName = so.customer_name; }
      } else if (tracking.order_id) {
        const { data: o } = await supabase.from('orders').select('user_id').eq('id', tracking.order_id).single();
        if (o?.user_id) {
          const { data: u } = await supabase.from('users').select('email, first_name').eq('id', o.user_id).single();
          if (u?.email) { emailAddress = u.email; customerName = u.first_name; }
        }
      }

      if (emailAddress) {
        const { sendEmail, EmailTemplates } = await import("@/lib/email-service");
        const payload = EmailTemplates.orderFailed(
          order.id.toString(),
          order.message || "Order could not be processed"
        );
        await sendEmail({
          to: [{ email: emailAddress, name: customerName }],
          subject: payload.subject,
          htmlContent: (payload as any).htmlContent || payload.html,
          referenceId: order.id.toString(),
          type: 'order_failed'
        });
        log("info", "Webhook", "Sent failure Email", { traceId, email: emailAddress });
      }
    } catch (emailError) {
      log("warn", "Webhook", "Failed to send failure Email", { traceId, error: String(emailError) });
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
 * Handle pending order
 */
async function handleOrderPending(
  traceId: string,
  payload: MTNWebhookPayload
): Promise<void> {
  const { order } = payload

  // Update tracking status
  await updateMTNOrderFromWebhook(payload)

  log("info", "Webhook", "Order status updated to pending", {
    traceId,
    mtnOrderId: order.id,
  })
}

/**
 * Handle processing order
 */
async function handleOrderProcessing(
  traceId: string,
  payload: MTNWebhookPayload
): Promise<void> {
  const { order } = payload

  // Update tracking status and order status via shared function
  await updateMTNOrderFromWebhook(payload)

  log("info", "Webhook", "Order status updated to processing", {
    traceId,
    mtnOrderId: order.id,
  })
}

/**
 * Update profit tracking on order completion
 */

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
