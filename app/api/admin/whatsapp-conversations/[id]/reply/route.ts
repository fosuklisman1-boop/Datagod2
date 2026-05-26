import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { sendWhatsAppText } from "@/lib/whatsapp-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = await request.json()
  const { message } = body

  if (!message || typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 })
  }
  if (message.length > 4096) {
    return NextResponse.json({ error: "message must be 4096 characters or fewer" }, { status: 400 })
  }

  const { data: conversation, error: convError } = await supabase
    .from("whatsapp_conversations")
    .select("phone_number")
    .eq("id", params.id)
    .maybeSingle()

  if (convError || !conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 })
  }

  const result = await sendWhatsAppText({
    phone: conversation.phone_number,
    message: message.trim(),
    conversationId: params.id,
    reference: `admin_reply:${adminId ?? "unknown"}`,
  })

  if (!result.success) {
    return NextResponse.json({ error: result.error ?? "Failed to send message" }, { status: 502 })
  }

  await supabase
    .from("whatsapp_conversations")
    .update({
      latest_outbound_at: new Date().toISOString(),
      last_message_preview: message.trim().slice(0, 240),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.id)

  return NextResponse.json({ success: true, messageId: result.messageId })
}
