// lib/wa-delivery-notify.ts
//
// Drains wa_delivery_outbox (filled by the order-table triggers in
// 20260615_wa_delivery_outbox.sql) and sends the customer a "your data has been
// delivered" WhatsApp confirmation. Runs out-of-band on a cron so it can never
// touch the fulfillment path.
//
// DELIVERY RULES (decided with the product owner):
//  - Notify the PURCHASER / account holder (the person who placed & paid),
//    resolved per order table — NOT the beneficiary, who often never messaged us.
//  - WARM ONLY: a free-form WhatsApp text only DELIVERS inside Meta's 24h
//    customer-service window (a send to a cold number returns 200 "accepted" then
//    is silently dropped). So we send only to numbers that messaged us recently,
//    and record everyone else as 'skipped_cold' (a delivery template could reach
//    them later — none is approved today).
//  - IDEMPOTENT: the outbox UNIQUE(order_table, order_id) guarantees one row per
//    order; the claim RPC flips pending -> processing under SKIP LOCKED so two
//    cron instances can't both send.
import { SupabaseClient } from "@supabase/supabase-js"
import { sendWhatsAppText } from "@/lib/whatsapp-bot/send"
import { logMessage } from "@/lib/whatsapp-bot/log-message"

// Below Meta's 24h window so borderline/clock-skew cases fall to 'skipped_cold'
// rather than a free-form text that would be silently dropped.
const WA_WINDOW_MS = 23 * 60 * 60 * 1000
// Per-run cap. With an every-minute cron this throttles a large bulk-complete
// (admin can flip thousands at once) to a Meta-friendly rate; warm-only filtering
// shrinks the real send volume far below this in practice.
const MAX_PER_RUN = 50
const MAX_ATTEMPTS = 3
// A claimed row whose worker died mid-run is handed back after this long.
const STALE_CLAIM_MS = 5 * 60 * 1000

/** Normalize a stored phone (0XXXXXXXXX or +233…) to WhatsApp's 233XXXXXXXXX. */
export function toWaPhone(phone: string): string {
  const raw = String(phone || "").replace(/\s/g, "")
  return raw.startsWith("0") ? `233${raw.slice(1)}` : raw.replace(/^\+/, "")
}

interface OutboxRow {
  id: string
  order_table: string
  order_id: string
  status: string
  attempts: number
}

interface Delivery {
  purchaserPhone: string | null
  recipientPhone: string | null
  detail: string
}

type OutboxStatus = "sent" | "skipped_cold" | "skipped" | "failed"

export interface DrainResult {
  claimed: number
  sent: number
  skippedCold: number
  skipped: number
  failed: number
}

/** Resolve the account holder's phone for a registered user, else null. */
async function userPhone(supabase: SupabaseClient, userId: string | null): Promise<string | null> {
  if (!userId) return null
  const { data } = await supabase.from("users").select("phone_number").eq("id", userId).maybeSingle()
  return (data?.phone_number as string) || null
}

/**
 * Resolve who to notify + what to say for one order. The purchaser column
 * differs per table (registered user_id -> users.phone_number where present,
 * else the phone that placed the order). Returns null if the order row is gone.
 */
async function resolveDelivery(supabase: SupabaseClient, table: string, id: string): Promise<Delivery | null> {
  switch (table) {
    case "orders": {
      const { data } = await supabase.from("orders").select("user_id, phone_number, network, size").eq("id", id).maybeSingle()
      if (!data) return null
      const purchaser = (await userPhone(supabase, data.user_id)) || data.phone_number || null
      return { purchaserPhone: purchaser, recipientPhone: data.phone_number || null, detail: `${data.size ?? ""} ${data.network ?? ""}`.trim() }
    }
    case "shop_orders": {
      const { data } = await supabase.from("shop_orders").select("customer_phone, network, volume_gb").eq("id", id).maybeSingle()
      if (!data) return null
      return { purchaserPhone: data.customer_phone || null, recipientPhone: data.customer_phone || null, detail: `${data.volume_gb ?? ""}GB ${data.network ?? ""}`.trim() }
    }
    case "ussd_orders": {
      const { data } = await supabase.from("ussd_orders").select("dialing_phone, recipient_phone, network, package_size").eq("id", id).maybeSingle()
      if (!data) return null
      return { purchaserPhone: data.dialing_phone || null, recipientPhone: data.recipient_phone || null, detail: `${data.package_size ?? ""} ${data.network ?? ""}`.trim() }
    }
    case "ussd_shop_orders": {
      const { data } = await supabase.from("ussd_shop_orders").select("dialing_phone, recipient_phone, network, package_size").eq("id", id).maybeSingle()
      if (!data) return null
      return { purchaserPhone: data.dialing_phone || null, recipientPhone: data.recipient_phone || null, detail: `${data.package_size ?? ""} ${data.network ?? ""}`.trim() }
    }
    case "airtime_orders": {
      const { data } = await supabase.from("airtime_orders").select("user_id, beneficiary_phone, dialing_phone, network, airtime_amount").eq("id", id).maybeSingle()
      if (!data) return null
      const purchaser = (await userPhone(supabase, data.user_id)) || data.dialing_phone || data.beneficiary_phone || null
      return { purchaserPhone: purchaser, recipientPhone: data.beneficiary_phone || null, detail: `₵${data.airtime_amount ?? ""} ${data.network ?? ""} airtime`.trim() }
    }
    default:
      return null
  }
}

/**
 * The "delivered" confirmation. Mentions the beneficiary number only when it
 * differs from the purchaser (so a self-purchase doesn't read "your order for
 * <your own number>"). Plain text — no Markdown (WhatsApp bold is single *).
 */
export function buildDeliveryMessage(d: Delivery): string {
  const differs =
    !!d.recipientPhone && !!d.purchaserPhone && toWaPhone(d.recipientPhone) !== toWaPhone(d.purchaserPhone)
  const forPart = differs ? ` for ${d.recipientPhone}` : ""
  const what = d.detail ? `Your ${d.detail} order${forPart}` : `Your order${forPart}`
  return `✅ Delivered! ${what} is complete.\n\nThank you! 🙏`
}

/**
 * Which of `waPhones` messaged us within the customer-service window. Returns
 * null on a query ERROR so the caller can un-claim and retry (rather than
 * terminally marking warm customers 'skipped_cold' on a transient blip).
 */
async function resolveWarm(supabase: SupabaseClient, waPhones: string[]): Promise<Set<string> | null> {
  if (waPhones.length === 0) return new Set()
  const cutoff = new Date(Date.now() - WA_WINDOW_MS).toISOString()
  const { data, error } = await supabase
    .from("whatsapp_conversations")
    .select("phone_number")
    .in("phone_number", waPhones)
    .gte("latest_inbound_at", cutoff)
  if (error) {
    console.warn("[WA-DELIVERY] warm lookup failed:", error.message)
    return null
  }
  return new Set((data || []).map((c: { phone_number: string }) => c.phone_number))
}

async function mark(supabase: SupabaseClient, id: string, status: OutboxStatus, lastError: string | null): Promise<void> {
  await supabase
    .from("wa_delivery_outbox")
    .update({
      status,
      last_error: lastError,
      sent_at: status === "sent" ? new Date().toISOString() : null,
    })
    .eq("id", id)
}

/**
 * Claim a batch and send each warm purchaser their delivery confirmation. Safe
 * to run concurrently with itself (SKIP LOCKED claim). Never throws into the
 * cron — returns a per-status tally.
 */
export async function drainDeliveryNotifications(supabase: SupabaseClient): Promise<DrainResult> {
  const empty: DrainResult = { claimed: 0, sent: 0, skippedCold: 0, skipped: 0, failed: 0 }

  // Hand stranded claims (worker died after claiming) back to the queue.
  const staleCutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
  await supabase.from("wa_delivery_outbox").update({ status: "pending" }).eq("status", "processing").lt("claimed_at", staleCutoff)

  const { data: claimed, error } = await supabase.rpc("claim_wa_delivery", { lim: MAX_PER_RUN, max_attempts: MAX_ATTEMPTS })
  if (error) throw error
  const rows = (claimed || []) as OutboxRow[]
  if (rows.length === 0) return empty

  // Resolve everyone first so the warm lookup is a single batched query.
  const resolved = await Promise.all(
    rows.map(async (row) => ({ row, delivery: await resolveDelivery(supabase, row.order_table, row.order_id).catch(() => null) }))
  )

  const waPhones = resolved
    .map((x) => (x.delivery?.purchaserPhone ? toWaPhone(x.delivery.purchaserPhone) : null))
    .filter((p): p is string => !!p)
  const warm = await resolveWarm(supabase, waPhones)
  if (warm === null) {
    // Transient lookup failure: un-claim the batch so it retries next run rather
    // than wrongly skipping warm customers as cold.
    await supabase.from("wa_delivery_outbox").update({ status: "pending" }).in("id", rows.map((r) => r.id))
    return empty
  }

  const result: DrainResult = { ...empty, claimed: rows.length }

  for (const { row, delivery } of resolved) {
    try {
      if (!delivery || !delivery.purchaserPhone) {
        await mark(supabase, row.id, "skipped", "no purchaser phone")
        result.skipped++
        continue
      }
      const waPhone = toWaPhone(delivery.purchaserPhone)
      if (!warm.has(waPhone)) {
        await mark(supabase, row.id, "skipped_cold", null)
        result.skippedCold++
        continue
      }
      const body = buildDeliveryMessage(delivery)
      const wamid = await sendWhatsAppText(waPhone, body)
      if (wamid) {
        await mark(supabase, row.id, "sent", null)
        result.sent++
        // Best-effort: mirror into the admin inbox thread (does NOT touch
        // latest_inbound_at, so it can't corrupt the warmth signal).
        logMessage(waPhone, "outbound", body, typeof wamid === "string" && wamid !== "sent" ? wamid : null).catch(() => {})
      } else {
        await mark(supabase, row.id, "failed", "send returned null")
        result.failed++
      }
    } catch (e: unknown) {
      await mark(supabase, row.id, "failed", String((e as Error)?.message || e)).catch(() => {})
      result.failed++
    }
  }

  return result
}
