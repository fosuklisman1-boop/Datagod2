import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const TAKEOVER_WINDOW_MS = 30 * 60 * 1000      // takeover heartbeat
const STALE_WINDOW_MS = 24 * 60 * 60 * 1000    // Meta 24h customer-service window
const PAGE_SIZE = 20

// GET /api/admin/whatsapp-inbox?search=&page=1
// Lists WhatsApp conversations (newest activity first) for the admin inbox.
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { searchParams } = new URL(request.url)
  const search = (searchParams.get("search") ?? "").trim()
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1)
  const offset = (page - 1) * PAGE_SIZE

  let query = supabase
    .from("whatsapp_conversations")
    .select(
      "id, phone_number, user_id, last_message_preview, latest_inbound_at, latest_outbound_at, updated_at, human_takeover, taken_over_by, taken_over_at",
      { count: "exact" }
    )
    .order("updated_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1)

  if (search) query = query.ilike("phone_number", `%${search}%`)

  const { data, count, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  const rows = data ?? []

  // Resolve customer names in one batched lookup (service-role; the anon client
  // can't read other users' rows). Guests (no user_id) stay null.
  const userIds = Array.from(new Set(rows.map(r => r.user_id).filter(Boolean))) as string[]
  const nameById = new Map<string, string>()
  if (userIds.length > 0) {
    const { data: users } = await supabase
      .from("users")
      .select("id, first_name, last_name")
      .in("id", userIds)
    for (const u of users ?? []) {
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim()
      if (name) nameById.set(u.id, name)
    }
  }

  const now = Date.now()
  const conversations = rows.map(r => {
    const takeoverActive =
      r.human_takeover === true &&
      !!r.taken_over_at &&
      now - new Date(r.taken_over_at).getTime() < TAKEOVER_WINDOW_MS
    const isStale = !r.latest_inbound_at || now - new Date(r.latest_inbound_at).getTime() > STALE_WINDOW_MS
    // Unread = the customer messaged after our last reply (or we've never replied).
    const unread =
      !!r.latest_inbound_at &&
      (!r.latest_outbound_at || new Date(r.latest_inbound_at).getTime() > new Date(r.latest_outbound_at).getTime())
    return {
      id: r.id,
      phone_number: r.phone_number,
      user_id: r.user_id,
      customer_name: r.user_id ? nameById.get(r.user_id) ?? null : null,
      last_message_preview: r.last_message_preview,
      latest_inbound_at: r.latest_inbound_at,
      latest_outbound_at: r.latest_outbound_at,
      updated_at: r.updated_at,
      human_takeover: r.human_takeover === true,
      taken_over_by: r.taken_over_by,
      takeover_active: takeoverActive,
      is_stale: isStale,
      unread,
    }
  })

  return NextResponse.json({ data: conversations, count: count ?? 0, page, limit: PAGE_SIZE })
}
