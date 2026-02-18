import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import {
    updateDataKazinaOrderFromPayload,
    DataKazinaWebhookPayload,
} from "@/lib/mtn-fulfillment"
import {
    log,
    generateTraceId,
    recordMetrics,
} from "@/lib/mtn-production-config"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { sendEmail, EmailTemplates } from "@/lib/email-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * POST /api/webhooks/mtn/datakazina
 * 
 * Handles incoming webhooks from DataKazina API.
 */
export async function POST(request: NextRequest) {
    const traceId = generateTraceId()
    const startTime = Date.now()

    try {
        const contentType = request.headers.get("content-type") || ""
        let payload: DataKazinaWebhookPayload

        if (!contentType.includes("application/json")) {
            const text = await request.text()
            log("info", "Webhook.DataKazina", "Received non-JSON webhook", { traceId, text: text.slice(0, 500) })
            // Return 200 for non-JSON pings (common for validation)
            return NextResponse.json({ success: true, message: "Ping received", traceId })
        }

        try {
            payload = await request.json()
        } catch (jsonError) {
            log("warn", "Webhook.DataKazina", "Failed to parse JSON body", { traceId })
            // Return 200 for empty or invalid JSON pings
            return NextResponse.json({ success: true, message: "Validation ping received", traceId })
        }

        log("info", "Webhook.DataKazina", "Received DataKazina webhook", {
            traceId,
            mtnOrderId: payload.transaction_id || payload.id || payload.reference,
            status: payload.status
        })

        // Validate payload
        const mtnOrderId = payload.transaction_id || payload.id || payload.reference || payload.incoming_api_ref
        if (!mtnOrderId) {
            log("info", "Webhook.DataKazina", "Webhook missing ID - likely a test ping", { traceId, payload })
            return NextResponse.json({ success: true, message: "Test received", traceId })
        }

        // Store webhook for audit
        await storeWebhookEvent(traceId, payload, JSON.stringify(payload))

        // Update order status in database
        const updated = await updateDataKazinaOrderFromPayload(payload)

        if (!updated) {
            log("warn", "Webhook.DataKazina", "Failed to update order or order not found", { traceId, mtnOrderId })
            // Return 200 to acknowledge receipt even if order not found locally
            return NextResponse.json({ success: true, message: "Webhook received", traceId })
        }

        // Process notifications based on status
        const status = String(payload.status || "").toLowerCase()
        const isCompleted = ["completed", "success", "successful", "delivered", "done"].includes(status)
        const isFailed = ["failed", "error", "cancelled", "rejected"].includes(status)

        if (isCompleted || isFailed) {
            // Get order details for notification
            const { data: tracking } = await supabase
                .from("mtn_fulfillment_tracking")
                .select("shop_order_id, order_id, order_type, recipient_phone, size_gb")
                .eq("mtn_order_id", String(mtnOrderId))
                .single()

            if (tracking) {
                if (isCompleted) {
                    await handleOrderCompleted(traceId, String(mtnOrderId), tracking)
                } else {
                    await handleOrderFailed(traceId, String(mtnOrderId), payload.message || status, tracking)
                }
            }
        }

        const latency = Date.now() - startTime
        recordMetrics(true, latency)

        return NextResponse.json({
            success: true,
            message: "Webhook processed",
            traceId,
        })
    } catch (error) {
        const latency = Date.now() - startTime
        recordMetrics(false, latency)

        log("error", "Webhook.DataKazina", "Webhook processing failed", {
            traceId,
            error: error instanceof Error ? error.message : String(error),
        })

        return NextResponse.json(
            { error: "Internal server error", traceId },
            { status: 500 }
        )
    }
}

/**
 * Handle order completion notifications and profits
 */
async function handleOrderCompleted(traceId: string, mtnOrderId: string, tracking: any) {
    // Send success SMS
    try {
        await sendSMS({
            phone: tracking.recipient_phone,
            message: SMSTemplates.orderDelivered(mtnOrderId),
            type: "order_delivered",
        })
    } catch (e) {
        log("warn", "Webhook.DataKazina", "Failed to send success SMS", { traceId, error: String(e) })
    }

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
            const payload = EmailTemplates.orderDelivered(
                mtnOrderId,
                "MTN",
                tracking.size_gb?.toString() || "Unknown"
            );
            await sendEmail({
                to: [{ email: emailAddress, name: customerName }],
                subject: payload.subject,
                htmlContent: (payload as any).htmlContent || payload.html,
                referenceId: mtnOrderId,
                type: 'order_delivered'
            });
            log("info", "Webhook.DataKazina", "Sent success Email", { traceId, email: emailAddress });
        }
    } catch (emailError) {
        log("warn", "Webhook.DataKazina", "Failed to send success Email", { traceId, error: String(emailError) });
    }
}

/**
 * Handle order failure notifications
 */
async function handleOrderFailed(traceId: string, mtnOrderId: string, message: string, tracking: any) {
    // Send failure SMS
    try {
        const orderId = tracking.shop_order_id || tracking.order_id || mtnOrderId
        await sendSMS({
            phone: tracking.recipient_phone,
            message: SMSTemplates.fulfillmentFailed(
                String(orderId).substring(0, 8),
                tracking.recipient_phone,
                "MTN",
                tracking.size_gb?.toString() || "Unknown",
                message
            ),
            type: "fulfillment_failed",
        })
    } catch (e) {
        log("warn", "Webhook.DataKazina", "Failed to send failure SMS", { traceId, error: String(e) })
    }
}

/**
 * Store webhook event for audit trail
 */
async function storeWebhookEvent(
    traceId: string,
    payload: DataKazinaWebhookPayload,
    rawBody: string
): Promise<void> {
    try {
        const mtnOrderId = payload.transaction_id || payload.id || payload.reference || payload.incoming_api_ref
        await supabase.from("mtn_webhook_events").insert({
            trace_id: traceId,
            event_type: "datakazina.webhook",
            mtn_order_id: mtnOrderId ? parseInt(String(mtnOrderId).replace(/\D/g, '')) || null : null,
            payload: payload,
            raw_body: rawBody,
            received_at: new Date().toISOString(),
        })
    } catch (error) {
        log("warn", "Webhook.DataKazina", "Failed to store webhook event", { traceId, error: String(error) })
    }
}

/**
 * GET /api/webhooks/mtn/datakazina
 * 
 * Simple health check.
 */
export async function GET() {
    return NextResponse.json({
        status: "ok",
        endpoint: "DataKazina Webhook Handler",
        timestamp: new Date().toISOString(),
    })
}
