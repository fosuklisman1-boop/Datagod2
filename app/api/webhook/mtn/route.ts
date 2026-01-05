import { NextRequest, NextResponse } from "next/server"
import { verifyWebhookSignature, updateMTNOrderFromWebhook, MTNWebhookPayload } from "@/lib/mtn-fulfillment"

/**
 * POST /api/webhook/mtn
 * Receive order status updates from MTN API
 */
export async function POST(request: NextRequest) {
  try {
    // Get raw body for signature verification
    const rawBody = await request.text()
    const signature = request.headers.get("x-webhook-signature")

    // Verify signature
    if (!signature || !verifyWebhookSignature(rawBody, signature)) {
      console.warn("[MTN Webhook] Invalid signature received")
      return NextResponse.json(
        { error: "Invalid signature" },
        { status: 401 }
      )
    }

    // Parse JSON
    const payload: MTNWebhookPayload = JSON.parse(rawBody)

    // Validate payload structure
    if (!payload.event || !payload.order || !payload.order.id) {
      console.warn("[MTN Webhook] Invalid payload structure:", payload)
      return NextResponse.json(
        { error: "Invalid payload" },
        { status: 400 }
      )
    }

    // Handle different event types
    if (payload.event === "order.status_changed") {
      const success = await updateMTNOrderFromWebhook(payload)

      if (!success) {
        console.error(
          `[MTN Webhook] Failed to update order ${payload.order.id}`,
          payload
        )
        // Still return 200 to acknowledge receipt
        // MTN will retry if we return error
      }

      return NextResponse.json({
        success: true,
        message: "Webhook processed",
        order_id: payload.order.id,
      })
    } else {
      console.warn(`[MTN Webhook] Unknown event type: ${payload.event}`)
      return NextResponse.json({
        success: true,
        message: "Event acknowledged",
      })
    }
  } catch (error) {
    console.error("[MTN Webhook] Error processing webhook:", error)

    // Return 200 to prevent MTN from retrying
    // Log the error for manual investigation
    return NextResponse.json({
      success: false,
      error: "Failed to process webhook",
      details: error instanceof Error ? error.message : "Unknown error",
    })
  }
}

/**
 * GET /api/webhook/mtn
 * Health check endpoint
 */
export async function GET(request: NextRequest) {
  return NextResponse.json({
    status: "ok",
    message: "MTN webhook receiver is active",
    timestamp: new Date().toISOString(),
  })
}
