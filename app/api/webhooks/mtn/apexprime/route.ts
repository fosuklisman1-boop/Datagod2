import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"
import { normalizeApexStatus } from "@/lib/mtn-providers/apexprime-provider"
import { isReversal, flagReversal } from "@/lib/mtn-reversal"
import { sendPushToUser } from "@/lib/push-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

interface ApexPrimeWebhookPayload {
  event: string
  order_id: number | string
  client_code?: string
  client_reference?: string
  network?: string
  recipient?: string
  gb_amount?: number
  channel?: string
  status: string
  message?: string
  timestamp?: string
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return crypto.timingSafeEqual(aBuf, bBuf)
}

/**
 * POST /api/webhooks/mtn/apexprime
 *
 * Apex Prime's webhooks are unsigned — authenticated via a shared secret we
 * embed in the callback_url we register with them (?token=) or an
 * x-webhook-token header, same pattern as Datakazina's webhook route.
 */
export async function POST(request: NextRequest) {
  try {
    const webhookSecret = process.env.APEXPRIME_WEBHOOK_SECRET
    const bodyText = await request.text()

    if (webhookSecret) {
      const providedToken =
        request.nextUrl.searchParams.get("token") ||
        request.headers.get("x-webhook-token") ||
        ""
      if (!timingSafeEqualStr(providedToken, webhookSecret)) {
        console.warn("[Webhook.ApexPrime] Invalid or missing webhook token")
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      }
    } else {
      console.warn("[Webhook.ApexPrime] APEXPRIME_WEBHOOK_SECRET not configured, skipping auth (INSECURE)")
    }

    let payload: ApexPrimeWebhookPayload
    try {
      payload = JSON.parse(bodyText)
    } catch {
      console.warn("[Webhook.ApexPrime] Failed to parse JSON body")
      return NextResponse.json({ success: true, message: "Non-JSON ping received" })
    }

    if (payload.event !== "order_status_update") {
      return NextResponse.json({ success: true, message: "Ignored non-order event" })
    }

    const clientReference = payload.client_reference
    if (!clientReference) {
      console.warn("[Webhook.ApexPrime] Missing client_reference in payload", payload)
    }

    // Primary correlation: client_reference is always our own internal order
    // UUID (the client_ref we sent as `reference`), for both GroupShare and
    // Store orders — Store orders never receive an order_id from Apex Prime
    // at all, so anchoring on order_id would silently fail for every one of
    // them.
    let tracking: any = null
    if (clientReference) {
      const { data } = await supabase
        .from("mtn_fulfillment_tracking")
        .select("id, order_type, order_id, shop_order_id, api_order_id, recipient_phone, size_gb, status, updated_at")
        .eq("provider", "apexprime")
        .or(`order_id.eq.${clientReference},shop_order_id.eq.${clientReference},api_order_id.eq.${clientReference}`)
        .maybeSingle()
      tracking = data
    }

    // Fallback: match by network + gb_amount + recipient among recent
    // pending/processing apexprime rows. Should never fire per their docs —
    // logged loudly if it does, so a real divergence is noticed immediately.
    if (!tracking && payload.network && payload.gb_amount && payload.recipient) {
      console.warn("[Webhook.ApexPrime] client_reference lookup failed, trying fallback match", { clientReference, payload })
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { data } = await supabase
        .from("mtn_fulfillment_tracking")
        .select("id, order_type, order_id, shop_order_id, api_order_id, recipient_phone, size_gb, status, updated_at")
        .eq("provider", "apexprime")
        .eq("recipient_phone", payload.recipient)
        .eq("size_gb", payload.gb_amount)
        .in("status", ["pending", "processing"])
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      tracking = data
    }

    if (!tracking) {
      console.warn("[Webhook.ApexPrime] No matching tracking row found", { clientReference, payload })
      return NextResponse.json({ success: true, message: "Webhook received, no matching order" })
    }

    const newStatus = normalizeApexStatus(payload.status)

    // Reversal safeguard: a webhook reporting failed for an order we already
    // marked completed (within the reversal window) is a provider reversal.
    if (newStatus === "failed" && isReversal({ trackingStatus: tracking.status, completedAt: tracking.updated_at, providerStatus: "failed" })) {
      await flagReversal(supabase, tracking, { status: payload.status, message: payload.message ?? payload.status })
      console.warn("[Webhook.ApexPrime] Reversal flagged (completed→failed)", { trackingId: tracking.id })
      return NextResponse.json({ success: true, message: "Reversal flagged" })
    }

    // No-op for non-terminal statuses (webhook retries/duplicates are safe).
    if (newStatus !== "completed" && newStatus !== "failed") {
      return NextResponse.json({ success: true, message: "Non-terminal status, no action" })
    }

    await supabase
      .from("mtn_fulfillment_tracking")
      .update({
        status: newStatus,
        external_status: payload.status,
        external_message: payload.message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", tracking.id)

    const orderTableStatus = newStatus === "failed" ? "pending" : newStatus
    let userId: string | null = null

    if (tracking.order_type === "bulk" && tracking.order_id) {
      const { data: o } = await supabase
        .from("orders")
        .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
        .eq("id", tracking.order_id)
        .select("user_id")
        .single()
      userId = o?.user_id ?? null
    } else if (tracking.order_type === "api" && (tracking.api_order_id || tracking.order_id)) {
      const { data: o } = await supabase
        .from("api_orders")
        .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
        .eq("id", tracking.api_order_id || tracking.order_id)
        .select("user_id")
        .single()
      userId = o?.user_id ?? null
    } else if (tracking.order_type === "ussd" && tracking.order_id) {
      await supabase
        .from("ussd_orders")
        .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
        .eq("id", tracking.order_id)
    } else if (tracking.order_type === "ussd_shop" && tracking.order_id) {
      await supabase
        .from("ussd_shop_orders")
        .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
        .eq("id", tracking.order_id)
    } else if (tracking.shop_order_id) {
      const { data: shopData } = await supabase
        .from("shop_orders")
        .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
        .eq("id", tracking.shop_order_id)
        .select("shop_id")
        .single()
      if (shopData?.shop_id) {
        const { data: shopOwner } = await supabase.from("user_shops").select("user_id").eq("id", shopData.shop_id).single()
        userId = shopOwner?.user_id ?? null
      }
    }

    if (userId && (newStatus === "completed" || newStatus === "failed")) {
      const title = newStatus === "completed" ? "Order Delivered Successfully" : "Order Delivery Failed"
      const body = newStatus === "completed"
        ? `Your ${tracking.size_gb ?? ""}GB data order to ${tracking.recipient_phone ?? "your number"} was delivered.`
        : `Your ${tracking.size_gb ?? ""}GB data order to ${tracking.recipient_phone ?? "your number"} could not be delivered.`
      await supabase.from("notifications").insert({
        user_id: userId,
        title,
        message: body,
        type: newStatus === "completed" ? "order_completed" : "order_failed",
        reference_id: tracking.api_order_id || tracking.order_id || tracking.shop_order_id,
        read: false,
      })
      sendPushToUser(userId, { title, body }).catch(() => {})
    }

    if (newStatus === "failed") {
      const { notifyAdmins, SMSTemplates } = await import("@/lib/sms-service")
      const orderId = tracking.shop_order_id || tracking.order_id || tracking.api_order_id
      notifyAdmins(
        SMSTemplates.fulfillmentFailed(String(orderId).substring(0, 8), tracking.recipient_phone, payload.network ?? "Unknown", String(tracking.size_gb ?? "?"), payload.message ?? "Failed"),
        "fulfillment_failure",
        String(orderId),
        true
      ).catch(() => {})
    }

    return NextResponse.json({ success: true, message: "Webhook processed" })
  } catch (error) {
    console.error("[Webhook.ApexPrime] Processing failed:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ status: "ok", endpoint: "Apex Prime Webhook Handler", timestamp: new Date().toISOString() })
}
