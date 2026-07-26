import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"
import { sendPushToUser } from "@/lib/push-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * EazyGhData signs webhooks Stripe-style: header "t=<unix>,v1=<hex>" where
 * v1 = HMAC-SHA256("<t>.<rawBody>", secret). Confirmed 2026-07-25 from their
 * webhook docs (they disabled order-status polling entirely — webhooks are now
 * the ONLY way to learn an order's outcome).
 *
 * Their issued secret carries a "whsec_" prefix, and their dashboard verifier
 * uses the key WITHOUT that prefix while their example code passes the secret
 * opaquely — so which variant their live sender uses is ambiguous. We accept a
 * signature computed with either key form.
 */
function verifySig(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false
  try {
    const parts = Object.fromEntries(header.split(",").map(kv => kv.split("=")))
    const t = parts["t"]
    const v1 = parts["v1"]
    if (!t || !v1) return false
    const b = Buffer.from(v1)
    const keys = secret.startsWith("whsec_") ? [secret, secret.slice(6)] : [secret]
    return keys.some(key => {
      const a = Buffer.from(crypto.createHmac("sha256", key).update(`${t}.${rawBody}`).digest("hex"))
      return a.length === b.length && crypto.timingSafeEqual(a, b)
    })
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const sigHeader = request.headers.get("x-eazygh-signature")
  const secret = process.env.EAZYGHDATA_WEBHOOK_SECRET

  if (!secret) {
    console.error("[WEBHOOK-EAZYGHDATA] EAZYGHDATA_WEBHOOK_SECRET not set — rejecting all requests")
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 })
  }
  if (!verifySig(rawBody, sigHeader, secret)) {
    console.warn(
      "[WEBHOOK-EAZYGHDATA] Signature rejected.",
      `x-eazygh-signature present: ${sigHeader !== null}`,
      `body preview: ${rawBody.slice(0, 200)}`
    )
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // Respond immediately, but keep the function alive until processing finishes —
  // a bare fire-and-forget call is not guaranteed to complete (Vercel can freeze
  // the function right after the response is sent). Same bug found and fixed in
  // the AgentPortalGH webhook 2026-07-26 — applying the same fix here preemptively.
  after(() => processEvent(payload))
  return NextResponse.json({ received: true })
}

async function processEvent(payload: any) {
  if (payload?.object !== "event" || (payload?.type !== "order.success" && payload?.type !== "order.failed")) {
    console.warn(`[WEBHOOK-EAZYGHDATA] Ignoring event object=${payload?.object} type=${payload?.type}. Payload keys: ${Object.keys(payload ?? {}).join(", ")}`)
    return
  }

  const data = payload.data ?? {}
  // data.id is EazyGhData's own order id — the same value createOrder() already
  // captures as mtn_order_id (data.order_id ?? data.id on their create response).
  // data.reference would be OUR reference if we sent one at order creation — we
  // currently don't (createOrder()'s request body has no reference field), so
  // it's expected to be absent for now; kept as a fallback in case that changes.
  const ref: string | undefined = data.id ?? data.reference
  if (!ref) {
    console.warn("[WEBHOOK-EAZYGHDATA] Payload has neither data.id nor data.reference, cannot match:", JSON.stringify(payload).slice(0, 300))
    return
  }

  const newStatus: "completed" | "failed" = payload.type === "order.success" ? "completed" : "failed"
  const externalMessage = data.status ?? payload.type

  const { data: tracking, error: trackingErr } = await supabase
    .from("mtn_fulfillment_tracking")
    .select("id, status, order_type, order_id, api_order_id, shop_order_id")
    .eq("mtn_order_id", ref)
    .maybeSingle()

  if (trackingErr || !tracking) {
    console.warn("[WEBHOOK-EAZYGHDATA] Tracking row not found for reference:", ref)
    return
  }

  // Prevent status regression
  const TERMINAL = new Set(["completed", "failed"])
  if (TERMINAL.has(tracking.status) && newStatus !== tracking.status) return

  const priority: Record<string, number> = { pending: 1, processing: 2, completed: 3, failed: 3 }
  if ((priority[newStatus] ?? 0) < (priority[tracking.status] ?? 0)) return

  await supabase
    .from("mtn_fulfillment_tracking")
    .update({ webhook_received_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", tracking.id)

  if (newStatus === tracking.status) return

  await supabase
    .from("mtn_fulfillment_tracking")
    .update({
      status: newStatus,
      external_status: externalMessage,
      external_message: externalMessage,
      webhook_received_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", tracking.id)

  // Mirror to the originating order table
  const orderTableStatus = newStatus === "failed" ? "pending" : newStatus
  let userId: string | null = null
  let phone: string | null = null
  let size: string | null = null
  let network: string | null = null

  if (tracking.order_type === "bulk" && tracking.order_id) {
    const { data: o } = await supabase
      .from("orders")
      .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", tracking.order_id)
      .select("user_id, network, size, phone_number")
      .single()
    if (o) { userId = o.user_id; phone = o.phone_number; size = o.size; network = o.network }
  } else if (tracking.order_type === "api" && (tracking.api_order_id || tracking.order_id)) {
    const apiId = tracking.api_order_id || tracking.order_id
    const { data: o } = await supabase
      .from("api_orders")
      .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", apiId)
      .select("user_id, network, volume_gb, recipient_phone")
      .single()
    if (o) { userId = o.user_id; phone = o.recipient_phone; size = `${o.volume_gb}GB`; network = o.network }
  } else if (tracking.order_type === "ussd" && tracking.order_id) {
    const { data: o } = await supabase
      .from("ussd_orders")
      .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", tracking.order_id)
      .select("network, package_size, recipient_phone")
      .single()
    if (o) { phone = o.recipient_phone; size = o.package_size; network = o.network }
  } else if (tracking.order_type === "ussd_shop" && tracking.order_id) {
    const { data: o } = await supabase
      .from("ussd_shop_orders")
      .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", tracking.order_id)
      .select("network, package_size, recipient_phone")
      .single()
    if (o) { phone = o.recipient_phone; size = o.package_size; network = o.network }
  } else if (tracking.shop_order_id) {
    const { data: o } = await supabase
      .from("shop_orders")
      .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", tracking.shop_order_id)
      .select("shop_id, network, volume_gb, customer_phone")
      .single()
    if (o) {
      phone = o.customer_phone; size = `${o.volume_gb}GB`; network = o.network
      const { data: shopOwner } = await supabase.from("user_shops").select("user_id").eq("id", o.shop_id).single()
      userId = shopOwner?.user_id ?? null
    }
  }

  if (userId && (newStatus === "completed" || newStatus === "failed")) {
    const title = newStatus === "completed" ? "Order Delivered Successfully" : "Order Delivery Failed"
    const body = newStatus === "completed"
      ? `Your ${size ?? ""} ${network ?? "MTN"} bundle for ${phone ?? "your number"} was delivered.`
      : `Your ${size ?? ""} ${network ?? "MTN"} bundle for ${phone ?? "your number"} could not be delivered. We will retry.`
    await sendPushToUser(userId, { title, body }).catch(() => null)
  }

  console.log(`[WEBHOOK-EAZYGHDATA] ${ref} → ${newStatus}`)
}
