import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { data, error } = await supabase
    .from("whatsapp_messages")
    .select("id, direction, message, meta_message_id, status, error_message, tool_context, created_at")
    .eq("conversation_id", params.id)
    .order("created_at", { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ messages: data ?? [] })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = await request.json()
  const { status } = body

  if (status !== "active" && status !== "closed") {
    return NextResponse.json({ error: "status must be 'active' or 'closed'" }, { status: 400 })
  }

  const { error } = await supabase
    .from("whatsapp_conversations")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", params.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
