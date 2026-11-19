// Customer complaints about a Kuntanii-delivered order go straight to Kuntanii as a
// "not received" report (owner ruling 2026-11-19), using the same claim-first filer
// as the admin button (fileNotReceived): one open report per order, phone and size
// always from our tracking row.
//
// - Website complaints: "order" category, linked to the order -> exact match.
// - WhatsApp complaints: "data" category. The beneficiary's NEWEST order in the last
//   7 days (any provider) must be a completed Kuntanii one — otherwise the complaint is
//   probably about that newer order, not an older Kuntanii bundle that arrived. Filed
//   only when the complainant is linked to the order (recipient, USSD dialler,
//   storefront customer or the account owner), so nobody can open disputes on a
//   stranger's order by naming their number.
// - Automatic filing happens at most once per order: once Kuntanii has reviewed a
//   report (resolved/rejected), only an admin can file again (/admin/mtn-logs).
//
// Kuntanii receives a fixed note only — never the customer's own text. Never logs
// phone numbers. Callers run this after responding and must not fail on it.

import { supabaseAdmin } from "@/lib/supabase"
import { fileNotReceived, type FileResult, type SupabaseLike } from "./kuntanii-disputes"
import { toLocalGhanaPhone } from "./kuntanii-core"

export const COMPLAINT_REASON_CODE = "CUSTOMER_COMPLAINT"
export const COMPLAINT_DESCRIPTION = "Customer reported the bundle was not received."
export const WHATSAPP_MATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

type FileFn = (input: {
  trackingId: string
  raisedBy: string | null
  reasonCode: string
  description: string
}) => Promise<FileResult>

export interface ComplaintDisputeDeps {
  db?: SupabaseLike
  file?: FileFn
}

export type ComplaintDisputeResult =
  | { filed: true; reportReference: string }
  | {
      filed: false
      reason:
        | "wrong_category"
        | "no_order"
        | "not_kuntanii"
        | "no_match"
        | "not_owner"
        | "already_open"
        | "already_reported"
        | "error"
    }

type TrackingRow = {
  id: string
  provider: string | null
  status: string | null
  order_type: string | null
  order_id: string | null
  shop_order_id: string | null
  api_order_id: string | null
}

const TRACKING_COLS = "id, provider, status, order_type, order_id, shop_order_id, api_order_id"

async function fileFor(
  db: SupabaseLike,
  trackingId: string,
  raisedBy: string | null,
  deps: ComplaintDisputeDeps,
): Promise<ComplaintDisputeResult> {
  // At most one automatic report per order, whatever happened to earlier ones.
  const { data: prior, error: priorErr } = await db
    .from("kuntanii_not_received_reports")
    .select("id")
    .eq("tracking_id", trackingId)
    .limit(1)
    .maybeSingle()
  if (priorErr) {
    console.error(`[KUNTANII-COMPLAINT] prior-report lookup failed for tracking ${trackingId}:`, priorErr.message)
    return { filed: false, reason: "error" }
  }
  if (prior) return { filed: false, reason: "already_reported" }

  const file: FileFn = deps.file ?? ((input) => fileNotReceived(input, { db }))
  const res = await file({ trackingId, raisedBy, reasonCode: COMPLAINT_REASON_CODE, description: COMPLAINT_DESCRIPTION })
  if (res.ok) return { filed: true, reportReference: res.reportReference }
  if (res.status === 409) return { filed: false, reason: "already_open" }
  console.error(`[KUNTANII-COMPLAINT] filing failed for tracking ${trackingId}: ${res.error}`)
  return { filed: false, reason: "error" }
}

/** Website support thread. Only "order" complaints linked to a completed Kuntanii order are filed. */
export async function disputeForSupportThread(
  input: { category: string; orderId?: string | null; shopOrderId?: string | null; userId: string },
  deps: ComplaintDisputeDeps = {},
): Promise<ComplaintDisputeResult> {
  if (input.category !== "order") return { filed: false, reason: "wrong_category" }
  if (!input.orderId && !input.shopOrderId) return { filed: false, reason: "no_order" }
  const db = deps.db ?? (supabaseAdmin as SupabaseLike)

  let q = db.from("mtn_fulfillment_tracking").select(TRACKING_COLS).eq("provider", "kuntanii").eq("status", "completed")
  // A support thread's order_id is always an `orders` (bulk) id.
  q = input.shopOrderId ? q.eq("shop_order_id", input.shopOrderId) : q.eq("order_id", input.orderId).eq("order_type", "bulk")
  const { data, error } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle()
  if (error) {
    console.error("[KUNTANII-COMPLAINT] tracking lookup failed:", error.message)
    return { filed: false, reason: "error" }
  }
  if (!data) return { filed: false, reason: "not_kuntanii" }
  return fileFor(db, (data as TrackingRow).id, input.userId, deps)
}

/** WhatsApp bot complaint. `senderPhone` is the WhatsApp number (233XXXXXXXXX). */
export async function disputeForWhatsAppComplaint(
  input: { senderPhone: string; beneficiaryNumber: string | null | undefined; category: string | null | undefined },
  deps: ComplaintDisputeDeps = {},
): Promise<ComplaintDisputeResult> {
  if (input.category !== "data") return { filed: false, reason: "wrong_category" }
  const beneficiary = input.beneficiaryNumber ? toLocalGhanaPhone(input.beneficiaryNumber) : null
  const sender = toLocalGhanaPhone(input.senderPhone)
  if (!beneficiary || !sender) return { filed: false, reason: "no_match" }
  const db = deps.db ?? (supabaseAdmin as SupabaseLike)

  const since = new Date(Date.now() - WHATSAPP_MATCH_WINDOW_MS).toISOString()
  const intl = "233" + beneficiary.slice(1)
  // The number's newest real attempt from ANY provider (abandoned = superseded, ignored).
  const { data, error } = await db
    .from("mtn_fulfillment_tracking")
    .select(TRACKING_COLS)
    .in("recipient_phone", [beneficiary, intl, "+" + intl])
    .in("status", ["pending", "processing", "completed", "failed", "reversed"])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error("[KUNTANII-COMPLAINT] WhatsApp tracking lookup failed:", error.message)
    return { filed: false, reason: "error" }
  }
  const row = data as TrackingRow | null
  if (!row || row.provider !== "kuntanii" || row.status !== "completed") return { filed: false, reason: "no_match" }

  if (beneficiary !== sender && !(await senderOwnsOrder(db, row, sender))) {
    return { filed: false, reason: "not_owner" }
  }
  return fileFor(db, row.id, null, deps)
}

/** Webhook entry point: takes the stored complaint row and never throws. */
export async function forwardWhatsAppComplaint(
  complaint: { phone_number: string; beneficiary_number: string | null; category: string | null },
  deps: ComplaintDisputeDeps = {},
): Promise<ComplaintDisputeResult> {
  try {
    return await disputeForWhatsAppComplaint(
      { senderPhone: complaint.phone_number, beneficiaryNumber: complaint.beneficiary_number, category: complaint.category },
      deps,
    )
  } catch (e) {
    console.error("[KUNTANII-COMPLAINT] WhatsApp forwarding threw:", e instanceof Error ? e.message : e)
    return { filed: false, reason: "error" }
  }
}

const same = (raw: unknown, local: string) => typeof raw === "string" && toLocalGhanaPhone(raw) === local

/** One-row lookup that logs (without values) when the query itself fails, so a schema slip is visible. */
async function lookup(db: SupabaseLike, table: string, cols: string, id: string): Promise<any | null> {
  const { data, error } = await db.from(table).select(cols).eq("id", id).maybeSingle()
  if (error) console.error(`[KUNTANII-COMPLAINT] ownership lookup on ${table} failed:`, error.message)
  return data ?? null
}

/** True when `sender` placed the order: USSD dialler, storefront customer, or the owning account's phone. */
async function senderOwnsOrder(db: SupabaseLike, row: TrackingRow, sender: string): Promise<boolean> {
  try {
    if (row.order_type === "ussd" || row.order_type === "ussd_shop") {
      if (!row.order_id) return false
      const order = await lookup(db, row.order_type === "ussd" ? "ussd_orders" : "ussd_shop_orders", "dialing_phone", row.order_id)
      return same(order?.dialing_phone, sender)
    }
    if (row.shop_order_id) {
      const order = await lookup(db, "shop_orders", "customer_phone", row.shop_order_id)
      return same(order?.customer_phone, sender)
    }
    const apiId = row.order_type === "api" ? row.api_order_id || row.order_id : null
    const id = apiId ?? row.order_id
    if (!id) return false
    const order = await lookup(db, apiId ? "api_orders" : "orders", "user_id", id)
    if (!order?.user_id) return false
    const user = await lookup(db, "users", "phone, phone_number", order.user_id)
    return same(user?.phone, sender) || same(user?.phone_number, sender)
  } catch (e) {
    console.error("[KUNTANII-COMPLAINT] ownership check failed:", e instanceof Error ? e.message : e)
    return false
  }
}
