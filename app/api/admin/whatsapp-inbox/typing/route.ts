import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { sendWaTyping } from "@/lib/whatsapp-bot/send"

export const dynamic = "force-dynamic"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST /api/admin/whatsapp-inbox/typing  { phone }
// Shows the customer a "typing…" indicator while an admin composes a reply in the
// inbox. WhatsApp keys the indicator to a RECEIVED message_id, so we attach it to
// the customer's latest inbound message. It auto-dismisses after ~25s or when the
// admin's reply lands, so the client just re-pings this periodically while typing.
// Best-effort: fire-and-forget, never blocks the composer.
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = await request.json().catch(() => ({})) as { phone?: string }
  const phone = String(body.phone ?? "").replace(/[^\d]/g, "")
  if (!phone) return NextResponse.json({ error: "phone is required" }, { status: 400 })

  // The indicator must reference a message we received; use the latest inbound.
  const { data: lastInbound } = await supabase
    .from("whatsapp_messages")
    .select("meta_message_id")
    .eq("phone_number", phone)
    .eq("direction", "inbound")
    .not("meta_message_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (lastInbound?.meta_message_id) void sendWaTyping(lastInbound.meta_message_id)
  return NextResponse.json({ ok: true })
}
