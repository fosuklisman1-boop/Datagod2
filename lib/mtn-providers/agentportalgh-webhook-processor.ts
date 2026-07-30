import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"
import { AgentPortalGHProvider, mapItemStatus } from "@/lib/mtn-providers/agentportalgh-provider"
import { sendPushToUser } from "@/lib/push-service"

// Webhook processing logic for the AgentPortalGH MTN fulfillment provider,
// extracted out of app/api/webhooks/mtn/agentportalgh/route.ts so it's unit
// testable — Next.js's typed-routes checker rejects any export from a
// route.ts file other than the HTTP method handlers and a small set of
// config constants, so `export async function processItem(...)` there fails
// the production build ("Route does not match the required types of a
// Next.js Route").

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

export async function processItems(payload: any) {
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

export async function processItem(item: any, ref: string | undefined) {
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

    // Same ambiguous-sibling guard as AgentPortalGHProvider.checkOrderStatus's
    // hasAmbiguousSibling check (lib/mtn-providers/agentportalgh-provider.ts,
    // added 2026-07-30 for the cron/on-demand status-check path after it was
    // confirmed live to attribute one order's outcome to a completely
    // unrelated order that happened to share the same phone+size within the
    // window — e.g. a customer's brand-new order created moments after an
    // older one to the same number/size, flipping the WRONG order to
    // "completed" before it was ever actually fulfilled. This webhook path
    // has its own, separate fallback that never got the same protection —
    // the previous `?? rows[0]` here blindly picked the most recent row for
    // the phone whenever no exact size match existed, which is even less
    // safe than the size-matching branch it was guarding. Refuse to guess
    // whenever the match is ambiguous; the order is left as-is (an exact
    // reference match or the cron poll can still resolve it later) rather
    // than risking a false "completed".
    if (sizeGb !== undefined) {
      const sizeMatches = rows.filter(r => Number(r.size_gb) === sizeGb)
      if (sizeMatches.length === 1) {
        tracking = sizeMatches[0]
      } else if (sizeMatches.length > 1) {
        console.warn(`[WEBHOOK-AGENTPORTALGH] Ambiguous phone+size fallback for msisdn=${item.msisdn}, size=${sizeGb}GB — ${sizeMatches.length} candidate tracking rows, refusing to guess`)
      }
      // sizeMatches.length === 0: no candidate matches this item's actual
      // size — never fall back to an unrelated size.
    } else if (rows.length === 1) {
      // No size on this item to disambiguate, but only one candidate for this
      // phone in the window anyway — safe to use it.
      tracking = rows[0]
    } else if (rows.length > 1) {
      console.warn(`[WEBHOOK-AGENTPORTALGH] Ambiguous phone-only fallback for msisdn=${item.msisdn} (no size on item) — ${rows.length} candidate tracking rows, refusing to guess`)
    }

    if (tracking) {
      console.log(`[WEBHOOK-AGENTPORTALGH] Matched by phone+size fallback (ref=${ref ?? "none"}, msisdn=${item.msisdn}): tracking ${tracking.id}`)
    }
  }

  if (!tracking) {
    console.warn("[WEBHOOK-AGENTPORTALGH] No tracking row found by reference or phone+size fallback:", ref, item.msisdn)
    return
  }

  // "completed" is genuinely terminal — never let anything override it.
  if (tracking.status === "completed" && newStatus !== "completed") return

  // "failed" is NOT necessarily final for AgentPortalGH: their queue
  // auto-retries failed items internally up to 3x (§8), and each retry can
  // arrive as its own separate webhook delivery — so one "failed" webhook only
  // reflects a single attempt. Confirmed live 2026-07-27: a batch of orders
  // we'd locked in as failed were later actually delivered by AgentPortalGH,
  // but this guard was silently dropping the correcting webhook because it
  // treated failed as equally terminal to completed. Let an eventual
  // "completed" through; still block a regression back to pending/processing.
  if (tracking.status === "failed" && newStatus !== "completed" && newStatus !== "failed") return

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
