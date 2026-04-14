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
    // Store webhook for audit immediately so we can see what was sent even if validation fails
    // Provide dummy values for trace ID etc. if it fails later
    await storeWebhookEvent(traceId, payload, rawBody)

    // Check if it's a test/ping webhook from the dashboard
    if (payload.event === "ping" || payload.event === "test") {
      log("info", "Webhook", "Received test/ping webhook", { traceId, payload })
      return NextResponse.json({ success: true, message: "Webhook endpoint tested successfully" })
    }

    // Some test webhooks may not include the full order object. 
    // If the event suggests a test, we should return 200.
    if (!payload.event || (!payload.order && !(payload as any).order_id && !(payload as any).transaction_id && !(payload as any).id)) {
      log("warn", "Webhook", "Missing required webhook fields, but storing and acking", { traceId, payload })
      // Notice we are returning 400 with a more detailed message, but maybe 
      // the test webhook specifically sends arbitrary payload. Let's return 200 if it's completely generic 
      // so the dashboard tester doesn't think the endpoint is unreachabe. 
      // Actually, if it's invalid, it's safer to return 400 with details.
      return NextResponse.json(
        { 
          error: "Missing required fields", 
          details: "Expected 'event' and 'order.id'", 
          received_payload: payload,
          traceId 
        },
        { status: 400 }
      )
    }

    // Determine the MTN order ID for logging (handle different potential formats of incoming payload)
    const mtnOrderId = payload.order?.id || (payload as any).order_id || (payload as any).transaction_id || (payload as any).id

    log("info", "Webhook", `Processing ${payload.event || "unknown"} event`, {
      traceId,
      mtnOrderId,
      status: payload.order?.status || (payload as any).status,
    })

    // Handle different event types
    // API uses "order.status_changed" with status in payload.order.status
    switch (payload.event) {
      case "order.status_changed":
        // Handle status from payload.order.status
        if (payload.order.status === "completed") {
          await handleOrderCompleted(traceId, payload)
        } else if (payload.order.status === "failed") {
          await handleOrderFailed(traceId, payload)
        } else if (payload.order.status === "processing") {
          await handleOrderProcessing(traceId, payload)
        } else if (payload.order.status === "pending") {
          await handleOrderPending(traceId, payload)
        }
        break

      case "order.completed":
      case "order.success":
        await handleOrderCompleted(traceId, payload)
        break

      case "order.failed":
      case "order.error":
        await handleOrderFailed(traceId, payload)
        break

      case "order.processing":
        await handleOrderProcessing(traceId, payload)
        break

      case "order.pending":
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
