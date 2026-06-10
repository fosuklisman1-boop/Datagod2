// lib/whatsapp-bot/admin-router.ts
//
// WhatsApp-based admin queue for the Results Check Service. Admin numbers are
// configured via admin_settings.results_check_admin_phones (see
// lib/results-checker-service.ts: getResultsCheckAdminPhones). Any of those
// admins can reply "pending" to list paid-but-undelivered requests, claim one,
// and deliver the result text and/or a photo/PDF — all from WhatsApp, as a full
// alternative to /admin/results-check-requests.
import { createClient } from "@supabase/supabase-js"
import { setWaSession, deleteWaSession } from "./session"
import { USSDSession } from "@/lib/ussd/types"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import {
  getResultsCheckAdminPhones,
  voucherInfoBlock,
  deliverResultsCheckRequest,
} from "@/lib/results-checker-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// A claim older than this is treated as stale and can be picked up by another admin.
const CLAIM_STALE_MS = 15 * 60 * 1000

// `from` is the raw inbound WhatsApp sender, e.g. "233559919037".
export async function isResultsCheckAdmin(from: string): Promise<boolean> {
  const local = normalizeGhanaPhone(from)
  if (!local) return false
  const phones = await getResultsCheckAdminPhones()
  return phones.includes(local)
}

interface PendingRow {
  id: string
  exam_board: string
  index_number: string
  exam_year: number
  mode: string
  channel: string
  phone_number: string
  payment_reference: string
  claimed_by: string | null
  claimed_at: string | null
}

async function listPendingForAdmin(adminPhone: string): Promise<{ reply: string; ids: string[] }> {
  const { data: rows } = await supabase
    .from("results_check_requests")
    .select("id, exam_board, index_number, exam_year, mode, channel, phone_number, payment_reference, claimed_by, claimed_at")
    .in("payment_status", ["paid", "completed"])
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(10)

  const staleCutoff = Date.now() - CLAIM_STALE_MS
  const available: PendingRow[] = (rows ?? []).filter((r: PendingRow) =>
    !r.claimed_by ||
    r.claimed_by === adminPhone ||
    (r.claimed_at !== null && new Date(r.claimed_at).getTime() < staleCutoff)
  )

  if (available.length === 0) {
    return { reply: "No pending requests right now.", ids: [] }
  }

  const lines = available.map((r, i) => {
    const mine = r.claimed_by === adminPhone ? " [yours]" : ""
    return `${i + 1}. ${r.exam_board} · ${r.index_number} (${r.exam_year}) · ${r.mode} · ${r.channel} · ${r.phone_number}${mine}`
  })

  return {
    reply: `Pending Results Check requests:\n\n${lines.join("\n")}\n\nReply with a number to pick it up, or 0 to cancel.`,
    ids: available.map(r => r.id),
  }
}

// Returns '' when the message isn't part of an admin RC flow, so the caller
// falls through to the normal bot/AI flow.
export async function adminRcRouter(
  from: string,
  text: string,
  session: USSDSession | null
): Promise<string> {
  const adminPhone = normalizeGhanaPhone(from)
  if (!adminPhone) return ''

  const trimmed = text.trim()

  // "pending" is a reserved keyword for admins, from any state.
  if (trimmed.toLowerCase() === "pending") {
    const { reply, ids } = await listPendingForAdmin(adminPhone)
    if (ids.length === 0) {
      await deleteWaSession(from)
      return reply
    }
    await setWaSession(from, { step: "ADMIN_RC_LIST", adminRcRequestIds: ids })
    return reply
  }

  if (session?.step === "ADMIN_RC_LIST") {
    if (trimmed === "0") {
      await deleteWaSession(from)
      return "Cancelled."
    }

    const ids = session.adminRcRequestIds ?? []
    const idx = parseInt(trimmed, 10)
    if (!Number.isInteger(idx) || idx < 1 || idx > ids.length) {
      return "Reply with a number from the list, or 0 to cancel."
    }

    const requestId = ids[idx - 1]
    const staleCutoff = new Date(Date.now() - CLAIM_STALE_MS).toISOString()
    const { data: claimed } = await supabase
      .from("results_check_requests")
      .update({ claimed_by: adminPhone, claimed_at: new Date().toISOString() })
      .eq("id", requestId)
      .or(`claimed_by.is.null,claimed_by.eq.${adminPhone},claimed_at.lt.${staleCutoff}`)
      .select("*")
      .maybeSingle()

    if (!claimed) {
      await deleteWaSession(from)
      return "Sorry, another admin just picked that up. Reply 'pending' to see what's left."
    }

    const modeLabel = claimed.mode === "combo" ? "Combo (voucher assigned)" : "Own voucher"
    const channelLabel = claimed.channel === "whatsapp" ? "WhatsApp" : claimed.channel === "web" ? "Web" : "USSD"
    const details =
      `${claimed.exam_board} · ${modeLabel}\n` +
      `Candidate: ${claimed.candidate_type ?? "—"}\n` +
      `Index: ${claimed.index_number}\n` +
      `DOB: ${claimed.dob ?? "—"}\n` +
      `Year: ${claimed.exam_year}\n` +
      `Channel: ${channelLabel} · ${claimed.phone_number}` +
      (claimed.whatsapp_number ? `\nWhatsApp: ${claimed.whatsapp_number}` : "") +
      `\nRef: ${claimed.payment_reference}` +
      voucherInfoBlock(claimed)

    await setWaSession(from, { step: "ADMIN_RC_AWAIT_CONTENT", adminRcSelectedId: requestId })

    return `${details}\n\nReply with the result text and/or send a photo/PDF. Reply 'send' when ready, or 'cancel' to release this request.`
  }

  if (session?.step === "ADMIN_RC_AWAIT_CONTENT") {
    const lower = trimmed.toLowerCase()

    if (lower === "cancel") {
      await supabase
        .from("results_check_requests")
        .update({ claimed_by: null, claimed_at: null })
        .eq("id", session.adminRcSelectedId)
      await deleteWaSession(from)
      return "Cancelled — released back to the queue."
    }

    if (lower === "send" || lower === "deliver") {
      if (!session.adminRcDraftText && !session.adminRcDraftMediaUrl) {
        return "Nothing to send yet — type the result text or attach a photo/PDF first."
      }

      await supabase
        .from("results_check_requests")
        .update({
          result_data: session.adminRcDraftText ?? null,
          media_url: session.adminRcDraftMediaUrl ?? null,
          media_type: session.adminRcDraftMediaType ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", session.adminRcSelectedId)

      const { deliveryNotes } = await deliverResultsCheckRequest(session.adminRcSelectedId!)
      await deleteWaSession(from)
      return `✓ Delivered.\n\n${deliveryNotes.join("\n")}`
    }

    // Free text — append to the draft result text.
    const updatedText = session.adminRcDraftText ? `${session.adminRcDraftText}\n${text}` : text
    await setWaSession(from, { ...session, adminRcDraftText: updatedText })
    return "📝 Noted. Reply 'send' when ready, attach a photo/PDF, or send more text."
  }

  return ''
}
