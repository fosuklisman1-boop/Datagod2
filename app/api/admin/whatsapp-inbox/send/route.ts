import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { sendWhatsAppText } from "@/lib/whatsapp-bot/send"
import { logMessage } from "@/lib/whatsapp-bot/log-message"

export const dynamic = "force-dynamic"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const STALE_WINDOW_MS = 24 * 60 * 60 * 1000

// POST /api/admin/whatsapp-inbox/send  { phone, message }
// Sends a manual admin reply, logs it to the thread, and (during a takeover)
// bumps the heartbeat so the 30-min auto-resume clock restarts.
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = await request.json().catch(() => ({})) as { phone?: string; message?: string }
  const phone = String(body.phone ?? "").replace(/[^\d]/g, "")
  const message = String(body.message ?? "").trim()

  if (!phone) return NextResponse.json({ error: "phone is required" }, { status: 400 })
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 })
  if (message.length > 4000) return NextResponse.json({ error: "message too long" }, { status: 400 })

  const { data: convo } = await supabase
    .from("whatsapp_conversations")
    .select("latest_inbound_at, human_takeover, taken_over_at")
    .eq("phone_number", phone)
    .maybeSingle()

  const stale =
    !convo?.latest_inbound_at || Date.now() - new Date(convo.latest_inbound_at).getTime() > STALE_WINDOW_MS

  // Free-form send. NOTE: outside the 24h window Meta returns 200 "accepted" then
  // silently drops, so `delivered` is necessary-but-not-sufficient — trust the
  // `stale` timestamp for the warning, not the send result.
  // TODO: when stale, switch to sendWhatsAppTemplate once a suitable support
  // template is approved in Meta Business Manager.
  const wamid = await sendWhatsAppText(phone, message)
  const delivered = !!wamid

  // Store the wamid so delivery/read status callbacks can drive the bubble ticks.
  await logMessage(phone, "outbound", message, wamid)

  // Keep an ACTIVE takeover alive: each admin reply resets the 30-min idle clock.
  // Only bump if the takeover hasn't already lapsed — otherwise a late reply
  // would silently resurrect a takeover the bot has effectively resumed from.
  const takeoverStillActive =
    convo?.human_takeover === true &&
    !!convo.taken_over_at &&
    Date.now() - new Date(convo.taken_over_at).getTime() < 30 * 60 * 1000
  if (takeoverStillActive) {
    await supabase
      .from("whatsapp_conversations")
      .update({ taken_over_at: new Date().toISOString() })
      .eq("phone_number", phone)
  }

  return NextResponse.json({
    ok: true,
    delivered,
    stale,
    warning: stale
      ? "Customer's last message was over 24h ago — WhatsApp may silently drop this free-form reply."
      : undefined,
  })
}
