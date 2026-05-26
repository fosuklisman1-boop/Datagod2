import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { searchParams } = new URL(request.url)
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"))
  const search = searchParams.get("search")?.trim() ?? ""
  const status = searchParams.get("status") ?? ""
  const matched = searchParams.get("matched") ?? ""
  const PAGE_SIZE = 20

  let query = supabase
    .from("whatsapp_conversations")
    .select(
      `id, phone_number, status, latest_inbound_at, latest_outbound_at, last_message_preview, created_at,
       user:user_id (first_name, last_name)`,
      { count: "exact" }
    )
    .order("latest_inbound_at", { ascending: false, nullsFirst: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)

  if (status === "active" || status === "closed") {
    query = query.eq("status", status)
  }
  if (matched === "true") {
    query = query.not("user_id", "is", null)
  } else if (matched === "false") {
    query = query.is("user_id", null)
  }
  if (search) {
    query = query.ilike("phone_number", `%${search}%`)
  }

  const { data, count, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ conversations: data ?? [], total: count ?? 0, page })
}
