import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"
import { AgentPortalGHProvider, mapItemStatus } from "@/lib/mtn-providers/agentportalgh-provider"
import { sendPushToUser } from "@/lib/push-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function verifySig(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex")
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header))
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const sigHeader = request.headers.get("x-webhook-signature")
  const secret = process.env.AGENTPORTALGH_WEBHOOK_SECRET

  if (!secret) {
    console.error("[WEBHOOK-AGENTPORTALGH] AGENTPORTALGH_WEBHOOK_SECRET not set — rejecting all requests")
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 })
  }
  if (!verifySig(rawBody, sigHeader, secret)) {
    // Log every header name received — if AgentPortalGH signs with a different
    // header or format than we expect, this is the only way to see it, since
    // no webhook_received_at ever gets stamped for a rejected delivery.
    console.warn(
      "[WEBHOOK-AGENTPORTALGH] Signature rejected.",
      `x-webhook-signature present: ${sigHeader !== null}`,
      `headers received: ${JSON.stringify([...request.headers.keys()])}`,
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
  // a bare fire-and-forget call here is not guaranteed to complete: Vercel can
  // freeze/terminate the function right after the response is sent, silently
  // dropping the update. Confirmed live 2026-07-26: AgentPortalGH's delivery log
  // showed 100% "Delivered (200)" while webhook_received_at never got set on a
  // single tracking row — the response was sent, but processItems() never ran
  // to completion.
  after(() => processItems(payload))
  return NextResponse.json({ received: true })
}

async function processItems(payload: any) {
  if (payload.event !== "order.completed") {
    console.warn(`[WEBHOOK-AGENTPORTALGH] Ignoring event "${payload.event}" (expected "order.completed"). Payload keys: ${Object.keys(payload).join(", ")}`)
    return
  }

  let items: any[] = payload.items ?? []

  // If payload was truncated, fetch the full item list from the API
  if (payload.items_truncated && payload.order_id) {
    try {
      const provider = new AgentPortalGHProvider()
      const full = await provider.getOrderItems(payload.order_id)
      items = full.data ?? full.items ?? items
    } catch {
      console.error("[WEBHOOK-AGENTPORTALGH] Failed to fetch full items for", payload.order_id)
    }
  }

  console.log(`[WEBHOOK-AGENTPORTALGH] order.completed ${payload.order_id}: ${items.length} item(s), success=${payload.success_count}, failure=${payload.failure_count}`)

  if (items.length === 0) {
    console.warn(`[WEBHOOK-AGENTPORTALGH] No items in payload for order ${payload.order_id}, nothing to process`)
    return
  }

  // Neither item.reference nor payload.order_id ever matches what we submit as
  // `reference` at /queue/add (confirmed via live payload capture 2026-07-26:
  // item.reference is always null, payload.order_id is AgentPortalGH's own
  // internal batch id). The reference we send is never echoed back anywhere in
  // this payload — processItem() falls back to matching by msisdn + data_mb.
  for (const item of items) {
    const ref: string | undefined = item.reference ?? payload.order_id
    await processItem(item, ref)
  }
}

async function processItem(item: any, ref: string | undefined) {
  const newStatus = mapItemStatus(item.status)
  const externalMessage = item.failed_reason ?? item.status ?? null

  let tracking:
    | { id: string; status: string; order_type: string; order_id: string | null; api_order_id: string | null; shop_order_id: string | null }
    | null = null

  if (ref) {
    const { data } = await supabase
      .from("mtn_fulfillment_tracking")
      .select("id, status, order_type, order_id, api_order_id, shop_order_id")
      .eq("mtn_order_id", ref)
      .maybeSingle()
    tracking = data
  }

  // Fall back to phone + size match against the most recent tracking row for
  // this provider — NOT restricted to pending/processing. The 1-minute polling
  // cron routinely resolves an order to completed/failed before AgentPortalGH's
  // webhook arrives (confirmed live 2026-07-26: webhook landed 7 minutes after
  // polling had already completed the same order), so a status-restricted
  // search finds nothing in the increasingly common case where polling won the
  // race. Matching regardless of status still lets us stamp webhook_received_at
  // for confirmation; the existing regression guard below prevents this from
  // ever re-opening an already-resolved order.
  if (!tracking && item.msisdn) {
    const { normalizeGhanaPhone } = await import("@/lib/phone-format")
    const normPhone = normalizeGhanaPhone(item.msisdn) ?? item.msisdn
    const sizeGb = typeof item.data_mb === "number" ? item.data_mb / 1024 : undefined
    const sinceIso = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()

    const { data: candidates } = await supabase
      .from("mtn_fulfillment_tracking")
      .select("id, status, order_type, order_id, api_order_id, shop_order_id, size_gb")
      .eq("provider", "agentportalgh")
      .eq("recipient_phone", normPhone)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(10)

    const rows = candidates ?? []
    tracking = (sizeGb !== undefined ? rows.find(r => Number(r.size_gb) === sizeGb) : undefined) ?? rows[0] ?? null

    if (tracking) {
      console.log(`[WEBHOOK-AGENTPORTALGH] Matched by phone+size fallback (ref=${ref ?? "none"}, msisdn=${item.msisdn}): tracking ${tracking.id}`)
    }
  }

  if (!tracking) {
    console.warn("[WEBHOOK-AGENTPORTALGH] No tracking row found by reference or phone+size fallback:", ref, item.msisdn)
    return
  }

  // Prevent status regression
  const TERMINAL = new Set(["completed", "failed"])
  if (TERMINAL.has(tracking.status) && newStatus !== tracking.status) return

  const priority: Record<string, number> = { pending: 1, processing: 2, completed: 3, failed: 3 }
  if ((priority[newStatus] ?? 0) < (priority[tracking.status] ?? 0)) return

  // Always record the webhook arrival time
  await supabase
    .from("mtn_fulfillment_tracking")
    .update({ webhook_received_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", tracking.id)

  if (newStatus === tracking.status) return

  await supabase
    .from("mtn_fulfillment_tracking")
    .update({
      status: newStatus,
      external_status: item.status,
      external_message: externalMessage,
      webhook_received_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", tracking.id)

  if (item.refunded_at) {
    console.log(`[WEBHOOK-AGENTPORTALGH] Order ${ref} auto-refunded by provider at ${item.refunded_at}`)
  }

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

  // In-app notification on terminal status
  if (userId && (newStatus === "completed" || newStatus === "failed")) {
    const title = newStatus === "completed" ? "Order Delivered Successfully" : "Order Delivery Failed"
    const body = newStatus === "completed"
      ? `Your ${size ?? ""} ${network ?? "MTN"} bundle for ${phone ?? "your number"} was delivered.`
      : `Your ${size ?? ""} ${network ?? "MTN"} bundle for ${phone ?? "your number"} could not be delivered. We will retry.`
    await sendPushToUser(userId, { title, body }).catch(() => null)
  }

  console.log(`[WEBHOOK-AGENTPORTALGH] ${ref} → ${newStatus}`)
}
