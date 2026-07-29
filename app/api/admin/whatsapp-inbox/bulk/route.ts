import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { resolveAllOpenComplaints } from "@/lib/whatsapp-bot/complaints"

export const dynamic = "force-dynamic"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST /api/admin/whatsapp-inbox/bulk  { action }
//
// Global inbox maintenance actions, each the bulk sibling of a per-conversation
// action. action ∈ "resolve_complaints" | "clear_wants_human" | "mark_all_read".
export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { action } = (await request.json().catch(() => ({}))) as { action?: string }

  // Resolve every OPEN (unclaimed) complaint. Claimed ones stay — they're worked
  // via the WhatsApp admin flow (see resolveAllOpenComplaints).
  if (action === "resolve_complaints") {
    const resolved = await resolveAllOpenComplaints(
      userId ? `admin:${userId}` : "admin",
      "Bulk-resolved from the WhatsApp inbox"
    )
    return NextResponse.json({ ok: true, resolved })
  }

  // Drop the "wants human" queue marker everywhere. Does NOT resolve complaints —
  // it only clears the flag (the two are intentionally separate buttons).
  if (action === "clear_wants_human") {
    const { data, error } = await supabase
      .from("whatsapp_conversations")
      .update({ wants_human: false, wants_human_at: null })
      .eq("wants_human", true)
      .select("id")
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ ok: true, cleared: data?.length ?? 0 })
  }

  // Mark every conversation read (clears the unread dot). Only admin_read_at is
  // touched — never updated_at — so the list order is unchanged (mirrors the
  // per-conversation mark-read).
  if (action === "mark_all_read") {
    const { data, error } = await supabase
      .from("whatsapp_conversations")
      .update({ admin_read_at: new Date().toISOString() })
      .not("latest_inbound_at", "is", null)
      .select("id")
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ ok: true, read: data?.length ?? 0 })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
