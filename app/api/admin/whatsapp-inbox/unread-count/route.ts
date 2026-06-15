import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// PostgREST can't compare two columns in a filter, so count "unread"
// (latest_inbound_at after our last reply) in JS over the most-recent slice.
// Unread chats are recent, so the cap is generous enough for a sidebar badge.
const CAP = 500

// GET /api/admin/whatsapp-inbox/unread-count → { count }
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { data } = await supabase
    .from("whatsapp_conversations")
    .select("latest_inbound_at, admin_read_at")
    .not("latest_inbound_at", "is", null)
    .order("updated_at", { ascending: false })
    .limit(CAP)

  let count = 0
  for (const r of data ?? []) {
    if (!r.admin_read_at || new Date(r.latest_inbound_at).getTime() > new Date(r.admin_read_at).getTime()) count++
  }

  return NextResponse.json({ count, capped: (data?.length ?? 0) >= CAP })
}
