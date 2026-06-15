import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const TAKEOVER_WINDOW_MS = 30 * 60 * 1000
const STALE_WINDOW_MS = 24 * 60 * 60 * 1000
const THREAD_LIMIT = 100

// GET /api/admin/whatsapp-inbox/<phone>?after=<ISO>
// Returns the live conversation row + the message thread (or just new messages
// after a timestamp, for incremental polling).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ phone: string }> }
) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { phone } = await params
  const { searchParams } = new URL(request.url)
  const after = searchParams.get("after")

  const { data: convo } = await supabase
    .from("whatsapp_conversations")
    .select("id, phone_number, user_id, wa_profile_name, human_takeover, taken_over_by, taken_over_at, latest_inbound_at, admin_read_at")
    .eq("phone_number", phone)
    .maybeSingle()

  // Opening (or polling) a thread marks it read — clears the unread dot. Only
  // write when there's actually something newer than the last read, to avoid a
  // DB write on every 3s poll.
  if (
    convo?.latest_inbound_at &&
    (!convo.admin_read_at || new Date(convo.latest_inbound_at).getTime() > new Date(convo.admin_read_at).getTime())
  ) {
    await supabase
      .from("whatsapp_conversations")
      .update({ admin_read_at: new Date().toISOString() })
      .eq("phone_number", phone)
  }

  // Resolve the names of the customer and the handling admin.
  let customerName: string | null = null
  let takenOverByName: string | null = null
  const ids = [convo?.user_id, convo?.taken_over_by].filter(Boolean) as string[]
  if (ids.length > 0) {
    const { data: users } = await supabase
      .from("users")
      .select("id, first_name, last_name")
      .in("id", ids)
    const nameOf = (id: string) => {
      const u = (users ?? []).find(x => x.id === id)
      const n = u ? [u.first_name, u.last_name].filter(Boolean).join(" ").trim() : ""
      return n || null
    }
    if (convo?.user_id) customerName = nameOf(convo.user_id)
    if (convo?.taken_over_by) takenOverByName = nameOf(convo.taken_over_by)
  }
  // Fall back to the captured WhatsApp display name for guests.
  if (!customerName) customerName = convo?.wa_profile_name ?? null

  let msgQuery = supabase
    .from("whatsapp_messages")
    .select("id, direction, message, status, created_at, meta_message_id, tool_context")
    .eq("phone_number", phone)
    .in("direction", ["inbound", "outbound"])
    .order("created_at", { ascending: true })

  if (after) msgQuery = msgQuery.gt("created_at", after)
  else msgQuery = msgQuery.limit(THREAD_LIMIT)

  const { data: messages, error } = await msgQuery
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  const now = Date.now()
  const takeoverActive =
    convo?.human_takeover === true &&
    !!convo.taken_over_at &&
    now - new Date(convo.taken_over_at).getTime() < TAKEOVER_WINDOW_MS
  const isStale =
    !convo?.latest_inbound_at || now - new Date(convo.latest_inbound_at).getTime() > STALE_WINDOW_MS

  return NextResponse.json({
    conversation: convo
      ? {
          phone_number: convo.phone_number,
          customer_name: customerName,
          human_takeover: convo.human_takeover === true,
          taken_over_by: convo.taken_over_by,
          taken_over_by_name: takenOverByName,
          taken_over_at: convo.taken_over_at,
          takeover_active: takeoverActive,
          is_stale: isStale,
        }
      : null,
    messages: messages ?? [],
  })
}
