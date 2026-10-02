import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"
import { mapSpfastitTelecelStatus } from "@/lib/mtn-providers/spfastit-telecel-provider"
import { sendPushToUser } from "@/lib/push-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/** Timing-safe comparison — SPFastIT's webhook has no signature, so auth is a shared token. */
export function verifyToken(provided: string | null, secret: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export async function processWebhook(payload: any) {
  const ref: string | number | undefined = payload.order_id
  if (ref === undefined || ref === null) {
    console.warn("[WEBHOOK-SPFASTIT-TELECEL] Payload missing order_id, cannot process:", payload)
    return
  }

  const newStatus = mapSpfastitTelecelStatus(payload.status)

  const { data: tracking } = await supabase
    .from("mtn_fulfillment_tracking")
    .select("id, status, order_type, order_id, api_order_id, shop_order_id")
    .eq("mtn_order_id", String(ref))
    .maybeSingle()

  if (!tracking) {
    console.warn("[WEBHOOK-SPFASTIT-TELECEL] No tracking row found for order_id:", ref)
    return
  }

  if ((tracking.status === "completed" || tracking.status === "failed") && newStatus !== tracking.status) {
    console.warn(`[WEBHOOK-SPFASTIT-TELECEL] Ignoring status "${payload.status}" (would move ${ref} from terminal "${tracking.status}" to "${newStatus}")`)
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
      external_message: payload.message ?? null,
      webhook_received_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", tracking.id)

  const orderTableStatus = newStatus === "failed" ? "pending" : newStatus
  let userId: string | null = null
  let phone: string | null = null
  let size: string | null = null

  if (tracking.order_type === "bulk" && tracking.order_id) {
    const { data: o } = await supabase
      .from("orders")
      .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", tracking.order_id)
      .select("user_id, phone_number, size")
      .single()
    if (o) { userId = o.user_id; phone = o.phone_number; size = o.size }
  } else if (tracking.order_type === "api" && (tracking.api_order_id || tracking.order_id)) {
    const apiId = tracking.api_order_id || tracking.order_id
    const { data: o } = await supabase
      .from("api_orders")
      .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", apiId)
      .select("user_id, volume_gb, recipient_phone")
      .single()
    if (o) { userId = o.user_id; phone = o.recipient_phone; size = `${o.volume_gb}GB` }
  } else if (tracking.order_type === "ussd" && tracking.order_id) {
    await supabase.from("ussd_orders").update({ order_status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", tracking.order_id)
  } else if (tracking.order_type === "ussd_shop" && tracking.order_id) {
    await supabase.from("ussd_shop_orders").update({ order_status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", tracking.order_id)
  } else if (tracking.shop_order_id) {
    const { data: o } = await supabase
      .from("shop_orders")
      .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", tracking.shop_order_id)
      .select("shop_id, customer_phone, volume_gb")
      .single()
    if (o) {
      phone = o.customer_phone; size = `${o.volume_gb}GB`
      const { data: shopOwner } = await supabase.from("user_shops").select("user_id").eq("id", o.shop_id).single()
      userId = shopOwner?.user_id ?? null
    }
  }

  if (userId && (newStatus === "completed" || newStatus === "failed")) {
    const title = newStatus === "completed" ? "Order Delivered Successfully" : "Order Delivery Failed"
    const body = newStatus === "completed"
      ? `Your ${size ?? ""} Telecel bundle for ${phone ?? "your number"} was delivered.`
      : `Your ${size ?? ""} Telecel bundle for ${phone ?? "your number"} could not be delivered.`
    await sendPushToUser(userId, { title, body }).catch(() => null)
  }

  console.log(`[WEBHOOK-SPFASTIT-TELECEL] ${ref} → ${newStatus}`)
}
