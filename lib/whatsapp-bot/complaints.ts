// lib/whatsapp-bot/complaints.ts
//
// Lightweight WhatsApp complaint intake. The bot AI files a complaint via the
// file_complaint tool; this creates the record, flags the conversation so it
// surfaces in the web inbox, and alerts the configured admin WhatsApp numbers
// (the Results Check admins) who can claim + resolve from WhatsApp. The admin
// claim/resolve flow lives in lib/whatsapp-bot/admin-router.ts (adminComplaintRouter).
import { createClient } from "@supabase/supabase-js"
import { getResultsCheckAdminPhones } from "@/lib/results-checker-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface WaComplaint {
  id: string
  phone_number: string
  customer_name: string | null
  description: string
  category: string
  beneficiary_number: string | null
  order_info: string | null
  status: string
}

const COMPLAINT_COLS = "id, phone_number, customer_name, description, category, beneficiary_number, order_info, status"
// Window during which a customer's incoming screenshot is attached to their
// most recent open complaint (a bit longer than the dedup window — they may send
// it a few minutes after filing).
const EVIDENCE_WINDOW_MS = 60 * 60 * 1000

const DEDUP_WINDOW_MS = 30 * 60 * 1000
const DAILY_CAP = 5  // max new complaints per phone per 24h (mirrors the web complaint cap)

export type CreateComplaintResult =
  | { complaint: WaComplaint; isNew: boolean }
  | { rateLimited: true }

// `phone` is the customer's WhatsApp number (233XXXXXXXXX). Returns the complaint
// plus whether it's new — a frustrated customer firing several messages would
// otherwise create (and re-alert admins about) duplicate complaints, so we reuse
// any open/claimed complaint from the same number within the dedup window.
export async function createComplaint(
  phone: string,
  description: string,
  details: { customerName?: string | null; beneficiaryNumber?: string | null; orderInfo?: string | null; category?: string | null } = {}
): Promise<CreateComplaintResult | null> {
  const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString()
  const { data: existing } = await supabase
    .from("whatsapp_complaints")
    .select(COMPLAINT_COLS)
    .eq("phone_number", phone)
    .in("status", ["open", "claimed"])
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing) return { complaint: existing as WaComplaint, isNew: false }

  // Daily cap per phone — stops a single number flooding the queue + admin alerts.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count } = await supabase
    .from("whatsapp_complaints")
    .select("id", { count: "exact", head: true })
    .eq("phone_number", phone)
    .gte("created_at", dayAgo)
  if ((count ?? 0) >= DAILY_CAP) return { rateLimited: true }

  const { data, error } = await supabase
    .from("whatsapp_complaints")
    .insert({
      phone_number: phone,
      customer_name: details.customerName ?? null,
      description,
      category: details.category ?? "other",
      beneficiary_number: details.beneficiaryNumber ?? null,
      order_info: details.orderInfo ?? null,
      status: "open",
    })
    .select(COMPLAINT_COLS)
    .single()
  if (error || !data) {
    console.error("[WA-COMPLAINT] create failed:", error?.message)
    return null
  }
  // Surface in the web inbox too (the "wants human" flag/sort).
  await supabase
    .from("whatsapp_conversations")
    .update({ wants_human: true, wants_human_at: new Date().toISOString() })
    .eq("phone_number", phone)
  return { complaint: data as WaComplaint, isNew: true }
}

// The customer's most recent open/claimed complaint, for attaching a screenshot
// they send shortly after filing. Null if none within the window.
export async function findRecentOpenComplaint(phone: string): Promise<{ id: string } | null> {
  const cutoff = new Date(Date.now() - EVIDENCE_WINDOW_MS).toISOString()
  const { data } = await supabase
    .from("whatsapp_complaints")
    .select("id")
    .eq("phone_number", phone)
    .in("status", ["open", "claimed"])
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ?? null
}

// Append an evidence screenshot URL to a complaint atomically (server-side cap
// of 10). Returns true if appended, false if capped or the complaint is gone.
export async function appendComplaintEvidence(complaintId: string, url: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("append_complaint_evidence", { p_id: complaintId, p_url: url })
  if (error) {
    console.error("[WA-COMPLAINT] append evidence failed:", error.message)
    return false
  }
  return (typeof data === "number" ? data : 0) > 0
}

export async function notifyAdminsNewComplaint(complaint: WaComplaint): Promise<void> {
  const who = complaint.customer_name || complaint.phone_number
  const message =
    `🛎️ New complaint (${complaint.category})\n\n` +
    `From: ${who}` + (complaint.customer_name ? ` (${complaint.phone_number})` : "") + `\n` +
    `Beneficiary: ${complaint.beneficiary_number || "—"}\n` +
    `Order/details: ${complaint.order_info || "—"}\n\n` +
    `"${complaint.description.slice(0, 400)}"\n\n` +
    `Reply "complaints" to view and resolve.`

  try {
    const phones = await getResultsCheckAdminPhones()
    const { sendWhatsAppText } = await import("./send")
    for (const local of phones) {
      const waPhone = local.startsWith("0") ? `233${local.slice(1)}` : local.replace(/^\+/, "")
      await sendWhatsAppText(waPhone, message).catch(e =>
        console.warn(`[WA-COMPLAINT] admin notify to ${local} failed:`, e)
      )
    }
  } catch (e) {
    console.warn("[WA-COMPLAINT] admin WhatsApp notify failed:", e)
  }

  // Also web-push the dashboard admins.
  try {
    const { notifyAdminsPush } = await import("@/lib/push-service")
    await notifyAdminsPush({
      title: `New complaint: ${who}`,
      body: complaint.description.slice(0, 140),
      data: { url: "/admin/whatsapp" },
    })
  } catch (e) {
    console.warn("[WA-COMPLAINT] admin push failed:", e)
  }
}
