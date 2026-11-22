import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { isUuid } from "@/lib/ai-console/review"

export const dynamic = "force-dynamic"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse!
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { data: conv, error } = await supabase.from("ai_conversations").select("id, reviewed_at").eq("id", id).maybeSingle()
  if (error) return NextResponse.json({ error: "Could not load conversation" }, { status: 500 })
  if (!conv) return NextResponse.json({ error: "Not found" }, { status: 404 })
  // Idempotent: keep the original reviewer and time.
  if (conv.reviewed_at) return NextResponse.json({ ok: true, reviewed_at: conv.reviewed_at })

  const reviewedAt = new Date().toISOString()
  const { error: uErr } = await supabase
    .from("ai_conversations")
    .update({ reviewed_at: reviewedAt, reviewed_by: userId ?? null })
    .eq("id", id)
    .is("reviewed_at", null)
  if (uErr) return NextResponse.json({ error: "Could not mark reviewed" }, { status: 500 })
  return NextResponse.json({ ok: true, reviewed_at: reviewedAt })
}
