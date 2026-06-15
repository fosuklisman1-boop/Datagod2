import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { sendWhatsAppText } from "@/lib/whatsapp-bot/send"
import { deleteWaSession } from "@/lib/whatsapp-bot/session"
import { logMessage } from "@/lib/whatsapp-bot/log-message"

export const dynamic = "force-dynamic"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const HANDOFF_NOTE = "You're now chatting with a member of our team. 👋"

// POST /api/admin/whatsapp-inbox/takeover  { phone, action: "take" | "release" }
// Toggles human takeover. On "take" the bot is muted, any half-finished bot
// session is cleared, and the customer gets a one-line handoff note. On
// "release" the bot resumes on the next inbound.
export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = await request.json().catch(() => ({})) as { phone?: string; action?: string }
  const phone = String(body.phone ?? "").replace(/[^\d]/g, "")
  const action = body.action

  if (!phone) return NextResponse.json({ error: "phone is required" }, { status: 400 })
  if (action !== "take" && action !== "release") {
    return NextResponse.json({ error: "action must be 'take' or 'release'" }, { status: 400 })
  }
  // verifyAdminAccess returns no userId for the CRON_SECRET bypass; a takeover
  // must record a real admin, so refuse it.
  if (action === "take" && !userId) {
    return NextResponse.json({ error: "Cannot determine acting admin" }, { status: 400 })
  }

  if (action === "take") {
    // Upsert (not update) so the takeover is set even if the row is somehow
    // missing — an update matching 0 rows would silently fail to mute the bot.
    const { error } = await supabase
      .from("whatsapp_conversations")
      .upsert(
        { phone_number: phone, human_takeover: true, taken_over_by: userId, taken_over_at: new Date().toISOString() },
        { onConflict: "phone_number" }
      )
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })

    // Clear any half-finished bot flow so it can't resume mid-takeover.
    await deleteWaSession(phone)

    // Courtesy heads-up (the customer just messaged, so the window is warm).
    const wamid = await sendWhatsAppText(phone, HANDOFF_NOTE)
    await logMessage(phone, "outbound", HANDOFF_NOTE, wamid)

    return NextResponse.json({ ok: true, human_takeover: true, taken_over_by: userId })
  }

  // release
  const { error } = await supabase
    .from("whatsapp_conversations")
    .update({ human_takeover: false, taken_over_by: null, taken_over_at: null })
    .eq("phone_number", phone)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ ok: true, human_takeover: false, taken_over_by: null })
}
