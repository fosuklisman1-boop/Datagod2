import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"
import { mapBundlePortalStatus } from "@/lib/mtn-providers/bundleportal-provider"
import { sendPushToUser } from "@/lib/push-service"

// Webhook processing logic for the Bundle Portal MTN fulfillment provider,
// extracted out of app/api/webhooks/mtn/bundleportal/route.ts so it's unit
// testable — Next.js's typed-routes checker rejects any export from a
// route.ts file other than the HTTP method handlers and a small set of
// config constants.
//
// Much simpler than agentportalgh-webhook-processor.ts: Bundle Portal's
// webhook payload's `order_id` field is documented as our own client-supplied
// reference directly, so lookup is a single direct query — no phone+size
// fallback matching, no ambiguous-sibling guard, no items array to iterate
// (one order per webhook delivery, not a batch).

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export function verifySig(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex")
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header))
  } catch {
    return false
  }
}

/** Bundle Portal's four documented webhook events, mapped to our canonical status set. */
function mapEventStatus(event: string, status: string): "pending" | "processing" | "completed" | "failed" {
  if (event === "order.cancelled" || event === "order.refunded") return "failed"
  return mapBundlePortalStatus(status)
}

export async function processWebhook(payload: any) {
  const ref: string | undefined = payload.order_id
  if (!ref) {
    console.warn("[WEBHOOK-BUNDLEPORTAL] Payload missing order_id, cannot process:", payload.event)
    return
  }

  const newStatus = mapEventStatus(payload.event, payload.status)

  const { data: tracking } = await supabase
    .from("mtn_fulfillment_tracking")
    .select("id, status, order_type, order_id, api_order_id, shop_order_id")
    .eq("mtn_order_id", ref)
    .maybeSingle()

  if (!tracking) {
    console.warn("[WEBHOOK-BUNDLEPORTAL] No tracking row found for order_id:", ref)
    return
  }

  // All four documented webhook events (completed/failed/cancelled/refunded)
  // are genuinely final per the docs' own is_final field, and — unlike
  // AgentPortalGH, which auto-retries a failed item internally up to 3x and
  // can later flip a "failed" webhook to "completed" — Bundle Portal's docs
  // describe "failed" as fully terminal ("Not delivered. Any charge is
  // reversed."), with no documented re-opening case. So both terminal states
  // are guarded here, simpler than AgentPortalGH's priority map.
  if ((tracking.status === "completed" || tracking.status === "failed") && newStatus !== tracking.status) {
    console.warn(`[WEBHOOK-BUNDLEPORTAL] Ignoring ${payload.event} (would move ${ref} from terminal "${tracking.status}" to "${newStatus}")`)
    return
  }

  if (newStatus === tracking.status) {
    await supabase.from("mtn_fulfillment_tracking").update({ webhook_received_at: new Date().toISOString() }).eq("id", tracking.id)
    return
  }

  await supabase
    .from("mtn_fulfillment_tracking")
    .update({
      status: newStatus,
      external_status: payload.status,
      external_message: payload.failure_reason ?? null,
      webhook_received_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", tracking.id)

  // Mirror to the originating order table + in-app notification: same
  // order_type branching (bulk/api/ussd/ussd_shop/shop) as
  // agentportalgh-webhook-processor.ts's processItem — reused verbatim here,
  // this provider has no phone+size fallback to complicate it.
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
      : `Your ${size ?? ""} ${network ?? "MTN"} bundle for ${phone ?? "your number"} could not be delivered.`
    await sendPushToUser(userId, { title, body }).catch(() => null)
  }

  console.log(`[WEBHOOK-BUNDLEPORTAL] ${ref} → ${newStatus}`)
}
