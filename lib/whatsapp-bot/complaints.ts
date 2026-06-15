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
  status: string
}

const DEDUP_WINDOW_MS = 30 * 60 * 1000

// `phone` is the customer's WhatsApp number (233XXXXXXXXX). Returns the complaint
// plus whether it's new — a frustrated customer firing several messages would
// otherwise create (and re-alert admins about) duplicate complaints, so we reuse
// any open/claimed complaint from the same number within the dedup window.
export async function createComplaint(
  phone: string,
  description: string,
  customerName?: string | null
): Promise<{ complaint: WaComplaint; isNew: boolean } | null> {
  const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString()
  const { data: existing } = await supabase
    .from("whatsapp_complaints")
    .select("id, phone_number, customer_name, description, status")
    .eq("phone_number", phone)
    .in("status", ["open", "claimed"])
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing) return { complaint: existing, isNew: false }

  const { data, error } = await supabase
    .from("whatsapp_complaints")
    .insert({ phone_number: phone, customer_name: customerName ?? null, description, status: "open" })
    .select("id, phone_number, customer_name, description, status")
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
  return { complaint: data, isNew: true }
}

export async function notifyAdminsNewComplaint(complaint: WaComplaint): Promise<void> {
  const who = complaint.customer_name || complaint.phone_number
  const message =
    `🛎️ New complaint\n\n` +
    `From: ${who}` + (complaint.customer_name ? ` (${complaint.phone_number})` : "") + `\n\n` +
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
