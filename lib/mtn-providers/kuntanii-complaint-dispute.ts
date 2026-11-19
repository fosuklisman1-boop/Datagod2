// Customer complaints about a Kuntanii-delivered order go straight to Kuntanii as a
// "not received" report (owner ruling 2026-11-19), using the same claim-first filer
// as the admin button (fileNotReceived): one open report per order, phone and size
// always from our tracking row.
//
// - Website complaints: "order" category, linked to the order -> exact match.
// - WhatsApp complaints: "data" category, matched by beneficiary number to the newest
//   completed Kuntanii order in the last 7 days. Filed only when the complainant is
//   linked to that order (recipient, USSD dialler, storefront customer or the account
//   owner), so nobody can open disputes on a stranger's order by naming their number.
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
  | { filed: false; reason: "wrong_category" | "no_order" | "not_kuntanii" | "no_match" | "not_owner" | "already_open" | "error" }

type TrackingRow = {
  id: string
  order_type: string | null
  order_id: string | null
  shop_order_id: string | null
  api_order_id: string | null
}

const TRACKING_COLS = "id, order_type, order_id, shop_order_id, api_order_id"

async function fileFor(trackingId: string, raisedBy: string | null, deps: ComplaintDisputeDeps): Promise<ComplaintDisputeResult> {
  const file: FileFn = deps.file ?? ((input) => fileNotReceived(input, { db: deps.db }))
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
  q = input.shopOrderId ? q.eq("shop_order_id", input.shopOrderId) : q.eq("order_id", input.orderId)
  const { data, error } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle()
  if (error) {
    console.error("[KUNTANII-COMPLAINT] tracking lookup failed:", error.message)
    return { filed: false, reason: "error" }
  }
  if (!data) return { filed: false, reason: "not_kuntanii" }
  return fileFor((data as TrackingRow).id, input.userId, deps)
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
  const { data, error } = await db
    .from("mtn_fulfillment_tracking")
    .select(TRACKING_COLS)
    .eq("provider", "kuntanii")
    .eq("status", "completed")
    .eq("recipient_phone", beneficiary)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error("[KUNTANII-COMPLAINT] WhatsApp tracking lookup failed:", error.message)
    return { filed: false, reason: "error" }
  }
  if (!data) return { filed: false, reason: "no_match" }
  const row = data as TrackingRow

  if (beneficiary !== sender && !(await senderOwnsOrder(db, row, sender))) {
    return { filed: false, reason: "not_owner" }
  }
  return fileFor(row.id, null, deps)
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

/** True when `sender` placed the order: USSD dialler, storefront customer, or the owning account's phone. */
async function senderOwnsOrder(db: SupabaseLike, row: TrackingRow, sender: string): Promise<boolean> {
  try {
    if ((row.order_type === "ussd" || row.order_type === "ussd_shop") && row.order_id) {
      const table = row.order_type === "ussd" ? "ussd_orders" : "ussd_shop_orders"
      const { data } = await db.from(table).select("dialing_phone").eq("id", row.order_id).maybeSingle()
      return same(data?.dialing_phone, sender)
    }
    if (row.shop_order_id) {
      const { data } = await db.from("shop_orders").select("customer_phone").eq("id", row.shop_order_id).maybeSingle()
      return same(data?.customer_phone, sender)
    }
    const apiId = row.order_type === "api" ? row.api_order_id || row.order_id : null
    const table = apiId ? "api_orders" : "orders"
    const id = apiId ?? row.order_id
    if (!id) return false
    const { data: order } = await db.from(table).select("user_id").eq("id", id).maybeSingle()
    if (!order?.user_id) return false
    const { data: user } = await db.from("users").select("phone, phone_number").eq("id", order.user_id).maybeSingle()
    return same(user?.phone, sender) || same(user?.phone_number, sender)
  } catch (e) {
    console.error("[KUNTANII-COMPLAINT] ownership check failed:", e instanceof Error ? e.message : e)
    return false
  }
}
