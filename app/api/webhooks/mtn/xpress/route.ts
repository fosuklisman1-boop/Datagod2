import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { log, generateTraceId, recordMetrics } from "@/lib/mtn-production-config"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { sendEmail, EmailTemplates } from "@/lib/email-service"
import crypto from "crypto"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

const XPRESS_WEBHOOK_SECRET = process.env.XPRESS_WEBHOOK_SECRET
const KNOWN_EVENTS = new Set(["order.updated", "item.completed", "item.failed", "item.refunded"])

/**
 * Verify HMAC-SHA256 signature from Xpress.
 * Checks candidate headers in priority order since the docs don't specify the header name.
 * Returns true when no secret is configured (insecure — set XPRESS_WEBHOOK_SECRET in env).
 */
function verifyXpressSignature(request: NextRequest, body: string): boolean {
    if (!XPRESS_WEBHOOK_SECRET) {
        log("warn", "Webhook.Xpress", "XPRESS_WEBHOOK_SECRET not set — skipping signature verification (INSECURE)")
        return true
    }

    // Xpress may use any of these; check all and accept if any matches
    const candidateHeaders = [
        "x-xpress-signature",
        "x-signature",
        "x-webhook-signature",
        "x-webhook-secret",
    ]

    const received = candidateHeaders
        .map(h => request.headers.get(h))
        .find(v => v !== null)

    if (!received) {
        log("warn", "Webhook.Xpress", "No signature header found in request")
        return false
    }

    const expected = crypto
        .createHmac("sha256", XPRESS_WEBHOOK_SECRET)
        .update(body)
        .digest("hex")

    // timingSafeEqual throws (not returns false) when buffer lengths differ,
    // so we must guard the length before each comparison.
    const safeEqual = (a: string, b: string) => {
        const ba = Buffer.from(a)
        const bb = Buffer.from(b)
        return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
    }

    // Accept both raw hex and "sha256=<hex>" formats
    return safeEqual(received, expected) || safeEqual(received, `sha256=${expected}`)
}

interface XpressWebhookPayload {
    event: string
    order_id: string
    status?: string
    items?: Array<{
        msisdn: string
        data_gb: number
        reference: string
        status: string
    }>
    delivered_at?: string
}

function normalizeStatus(raw: string): "pending" | "processing" | "completed" | "failed" {
    const s = raw.toLowerCase().trim()
    if (["completed", "success", "successful", "delivered", "done"].includes(s)) return "completed"
    if (["failed", "error", "cancelled", "rejected", "refunded"].includes(s)) return "failed"
    if (["processing", "in_progress", "queued", "submitted"].includes(s)) return "processing"
    return "pending"
}

/**
 * POST /api/webhooks/mtn/xpress
 *
 * Handles incoming webhooks from the Xpress Agent API.
 * Events: order.updated, item.completed, item.failed, item.refunded
 *
 * Configure your webhook endpoint in the Xpress dashboard Overview page.
 * Xpress retries up to 5 times with exponential backoff on non-2xx responses.
 */
export async function POST(request: NextRequest) {
    const traceId = generateTraceId()
    const startTime = Date.now()

    try {
        const eventType = request.headers.get("X-Xpress-Event") || ""
        const bodyText = await request.text()

        // Verify HMAC-SHA256 signature
        if (!verifyXpressSignature(request, bodyText)) {
            log("warn", "Webhook.Xpress", "Invalid webhook signature — rejecting request", { traceId })
            return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
        }

        // Validate it's a known event type before doing any work
        if (!KNOWN_EVENTS.has(eventType) && eventType !== "") {
            log("info", "Webhook.Xpress", `Unknown event type: ${eventType} — acknowledging`, { traceId })
            return NextResponse.json({ success: true, message: "Unknown event acknowledged", traceId })
        }

        const contentType = request.headers.get("content-type") || ""
        if (!contentType.includes("application/json") || !bodyText) {
            log("info", "Webhook.Xpress", "Non-JSON or empty body — likely a validation ping", { traceId })
            return NextResponse.json({ success: true, message: "Ping received", traceId })
        }

        let payload: XpressWebhookPayload
        try {
            payload = JSON.parse(bodyText)
        } catch {
            log("warn", "Webhook.Xpress", "Failed to parse JSON body", { traceId })
            return NextResponse.json({ success: true, message: "Validation ping received", traceId })
        }

        log("info", "Webhook.Xpress", "Received Xpress webhook", {
            traceId,
            event: payload.event,
            order_id: payload.order_id,
            status: payload.status,
        })

        if (!payload.order_id) {
            log("info", "Webhook.Xpress", "Webhook missing order_id — likely a test ping", { traceId })
            return NextResponse.json({ success: true, message: "Test received", traceId })
        }

        // Store for audit trail
        await storeWebhookEvent(traceId, payload, bodyText)

        // Determine the effective status:
        // - For order.updated use the top-level status
        // - For item.* events, derive from the first item (single-item orders)
        let rawStatus = payload.status || ""
        if (!rawStatus && payload.items?.length) {
            rawStatus = payload.items[0].status
        }

        if (!rawStatus) {
            log("warn", "Webhook.Xpress", "No status in payload", { traceId, payload })
            return NextResponse.json({ success: true, message: "No status to process", traceId })
        }

        const newStatus = normalizeStatus(rawStatus)

        // Status priority guard — never regress completed/failed back to pending
        const statusPriority: Record<string, number> = { pending: 1, processing: 2, completed: 3, failed: 3 }

        const { data: tracking, error: fetchError } = await supabase
            .from("mtn_fulfillment_tracking")
            .select("id, status, shop_order_id, order_id, api_order_id, order_type, recipient_phone, size_gb")
            .eq("mtn_order_id", payload.order_id)
            .eq("provider", "xpress")
            .single()

        if (fetchError || !tracking) {
            log("warn", "Webhook.Xpress", "Tracking record not found for order", { traceId, order_id: payload.order_id })
            // Still 200 so Xpress doesn't retry for an unknown order
            return NextResponse.json({ success: true, message: "Order not found locally", traceId })
        }

        const currentPriority = statusPriority[tracking.status] ?? 0
        const newPriority = statusPriority[newStatus] ?? 0

        if (newPriority < currentPriority) {
            log("info", "Webhook.Xpress", `Blocking status regression: ${tracking.status} -> ${newStatus}`, { traceId })
            return NextResponse.json({ success: true, message: "Status regression blocked", traceId })
        }

        // Update tracking record
        const { error: updateError } = await supabase
            .from("mtn_fulfillment_tracking")
            .update({
                status: newStatus,
                external_status: rawStatus,
                external_message: `Xpress ${payload.event}: ${rawStatus}`,
                webhook_payload: payload,
                webhook_received_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq("id", tracking.id)

        if (updateError) {
            log("error", "Webhook.Xpress", "Failed to update tracking record", { traceId, error: updateError.message })
            return NextResponse.json({ error: "DB update failed" }, { status: 500 })
        }

        // Mirror status to the originating order table
        if (tracking.order_type === "bulk" && tracking.order_id) {
            await supabase.from("orders").update({ status: newStatus, updated_at: new Date().toISOString() }).eq("id", tracking.order_id)
        } else if (tracking.order_type === "api" && (tracking.api_order_id || tracking.order_id)) {
            const apiId = tracking.api_order_id || tracking.order_id
            await supabase.from("api_orders").update({ status: newStatus, updated_at: new Date().toISOString() }).eq("id", apiId)
        } else if (tracking.order_type === "ussd" && tracking.order_id) {
            await supabase.from("ussd_orders").update({ order_status: newStatus, updated_at: new Date().toISOString() }).eq("id", tracking.order_id)
        } else if (tracking.order_type === "ussd_shop" && tracking.order_id) {
            await supabase.from("ussd_shop_orders").update({ order_status: newStatus, updated_at: new Date().toISOString() }).eq("id", tracking.order_id)
        } else if (tracking.shop_order_id) {
            await supabase.from("shop_orders").update({ order_status: newStatus, updated_at: new Date().toISOString() }).eq("id", tracking.shop_order_id)
        }

        // Send notifications on terminal states
        if (newStatus === "completed") {
            await handleOrderCompleted(traceId, payload.order_id, tracking)
        } else if (newStatus === "failed") {
            await handleOrderFailed(traceId, payload.order_id, `Xpress ${payload.event}: ${rawStatus}`, tracking)
        }

        recordMetrics(true, Date.now() - startTime)

        return NextResponse.json({ success: true, message: "Webhook processed", traceId })
    } catch (error) {
        recordMetrics(false, Date.now() - startTime)
        log("error", "Webhook.Xpress", "Webhook processing failed", {
            traceId,
            error: error instanceof Error ? error.message : String(error),
        })
        return NextResponse.json({ error: "Internal server error", traceId }, { status: 500 })
    }
}

async function handleOrderCompleted(traceId: string, orderId: string, tracking: any) {
    try {
        let emailAddress: string | undefined
        let customerName: string | undefined

        if (tracking.shop_order_id) {
            const { data: so } = await supabase.from("shop_orders").select("customer_email, customer_name").eq("id", tracking.shop_order_id).single()
            if (so?.customer_email) { emailAddress = so.customer_email; customerName = so.customer_name }
        } else if (tracking.order_id) {
            const { data: o } = await supabase.from("orders").select("user_id").eq("id", tracking.order_id).single()
            if (o?.user_id) {
                const { data: u } = await supabase.from("users").select("email, first_name").eq("id", o.user_id).single()
                if (u?.email) { emailAddress = u.email; customerName = u.first_name }
            }
        }

        if (emailAddress) {
            const tmpl = EmailTemplates.orderDelivered(orderId, "MTN", tracking.size_gb?.toString() || "Unknown")
            await sendEmail({
                to: [{ email: emailAddress, name: customerName }],
                subject: tmpl.subject,
                htmlContent: (tmpl as any).htmlContent || tmpl.html,
                referenceId: orderId,
                type: "order_delivered",
            })
            log("info", "Webhook.Xpress", "Sent delivery email", { traceId, email: emailAddress })
        }
    } catch (e) {
        log("warn", "Webhook.Xpress", "Failed to send delivery email", { traceId, error: String(e) })
    }
}

async function handleOrderFailed(traceId: string, orderId: string, message: string, tracking: any) {
    try {
        const displayId = (tracking.shop_order_id || tracking.order_id || orderId).toString().substring(0, 8)
        const { notifyAdmins } = await import("@/lib/sms-service")
        await notifyAdmins(
            SMSTemplates.fulfillmentFailed(
                displayId,
                tracking.recipient_phone,
                "MTN",
                tracking.size_gb?.toString() || "Unknown",
                message
            ),
            "fulfillment_failure",
            displayId,
            true
        )
        import("@/lib/push-service").then(({ notifyAdminsPush }) => {
            notifyAdminsPush({
                title: "⚠️ Fulfillment Failed",
                body: `Xpress MTN ${tracking.size_gb || "?"}GB to ${tracking.recipient_phone} — ${message} (Order: ${displayId})`,
                data: { url: "/admin/orders" },
            }).catch(() => {})
        }).catch(() => {})
    } catch (e) {
        log("warn", "Webhook.Xpress", "Failed to notify admins of failure", { traceId, error: String(e) })
    }
}

async function storeWebhookEvent(traceId: string, payload: XpressWebhookPayload, rawBody: string) {
    try {
        await supabase.from("mtn_webhook_events").insert({
            trace_id: traceId,
            event_type: `xpress.${payload.event || "webhook"}`,
            mtn_order_id: null, // Xpress uses UUID order_ids — not stored as integer
            payload,
            raw_body: rawBody,
            received_at: new Date().toISOString(),
        })
    } catch (e) {
        log("warn", "Webhook.Xpress", "Failed to store webhook event", { traceId, error: String(e) })
    }
}

/**
 * GET /api/webhooks/mtn/xpress — health check / endpoint validation
 */
export async function GET() {
    return NextResponse.json({
        status: "ok",
        endpoint: "Xpress Webhook Handler",
        timestamp: new Date().toISOString(),
    })
}
