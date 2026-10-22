import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"

const STATUSES = ["pending", "active", "revoked"]
const TYPES = ["standard", "commission", "sms"]
const LIST_COLUMNS =
  "id, user_id, key_type, environment, status, name, key_prefix, rate_limits, last_used_at, created_at, approved_at, approved_by, revoked_at, revoked_by, updated_at"
const CHUNK = 200

/** GET /api/admin/api-v2/keys - Admin: list v2 keys with owner, newest first. */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { searchParams } = new URL(request.url)
  const status = searchParams.get("status")
  const type = searchParams.get("type")
  if (status && !STATUSES.includes(status)) {
    return NextResponse.json({ error: "Invalid status filter" }, { status: 400 })
  }
  if (type && !TYPES.includes(type)) {
    return NextResponse.json({ error: "Invalid type filter" }, { status: 400 })
  }

  const supabase = getAdminClient()
  let query = supabase.from("api_v2_keys").select(LIST_COLUMNS).order("created_at", { ascending: false })
  if (status) query = query.eq("status", status)
  if (type) query = query.eq("key_type", type)

  const { data: keys, error } = await query
  if (error) {
    console.error("[ADMIN API V2] List keys error:", error)
    return NextResponse.json({ error: "Failed to fetch API keys" }, { status: 500 })
  }

  const rows = (keys ?? []) as Array<{ user_id: string }>
  const userIds = Array.from(new Set(rows.map((k) => k.user_id)))
  const owners = new Map<string, unknown>()
  for (let i = 0; i < userIds.length; i += CHUNK) {
    const { data: users, error: usersError } = await supabase
      .from("users")
      .select("id, first_name, last_name, email, role")
      .in("id", userIds.slice(i, i + CHUNK))
    if (usersError) {
      console.error("[ADMIN API V2] Owner lookup error:", usersError)
      return NextResponse.json({ error: "Failed to fetch key owners" }, { status: 500 })
    }
    for (const u of (users ?? []) as Array<{ id: string }>) owners.set(u.id, u)
  }

  return NextResponse.json({
    keys: rows.map((k) => ({ ...k, owner: owners.get(k.user_id) ?? null })),
  })
}
