import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { audienceLabel, isUuid, shortId } from "@/lib/ai-console/review"

export const dynamic = "force-dynamic"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse!
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { data: conv, error } = await supabase
    .from("ai_conversations")
    .select("id, context, user_id, shop_id, started_at, last_at, message_count, flagged, flag_reasons, reviewed_at")
    .eq("id", id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: "Could not load conversation" }, { status: 500 })
  if (!conv) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { data: msgs, error: mErr } = await supabase
    .from("ai_conversation_messages")
    .select("role, text, created_at")
    .eq("conversation_id", id)
    .order("id", { ascending: true })
  if (mErr) return NextResponse.json({ error: "Could not load messages" }, { status: 500 })

  return NextResponse.json({
    conversation: {
      id: conv.id,
      context: conv.context,
      audience: audienceLabel(conv.context, conv.user_id ?? null, conv.shop_id ?? null),
      user: shortId(conv.user_id),
      shop: shortId(conv.shop_id),
      started_at: conv.started_at,
      last_at: conv.last_at,
      message_count: conv.message_count,
      flagged: conv.flagged,
      flag_reasons: conv.flag_reasons ?? [],
      reviewed_at: conv.reviewed_at,
    },
    messages: ((msgs ?? []) as Array<{ role: string; text: string; created_at: string }>).map((m) => ({
      role: m.role,
      text: m.text,
      created_at: m.created_at,
    })),
  })
}
