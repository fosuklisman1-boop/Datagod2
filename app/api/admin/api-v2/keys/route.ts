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

  const rows = (keys ?? []) as Array<{ id: string; user_id: string }>
  const userIds = Array.from(new Set(rows.map((k) => k.user_id)))
  const owners = new Map<string, unknown>()
  for (let i = 0; i < userIds.length; i += CHUNK) {
    const { data: users, error: usersError } = await supabase
      .from("users")
      .select("id, first_name, last_name, email, role, phone_number")
      .in("id", userIds.slice(i, i + CHUNK))
    if (usersError) {
      console.error("[ADMIN API V2] Owner lookup error:", usersError)
      return NextResponse.json({ error: "Failed to fetch key owners" }, { status: 500 })
    }
    for (const u of (users ?? []) as Array<{ id: string; phone_number?: string | null }>) {
      const { phone_number, ...rest } = u
      owners.set(u.id, { ...rest, phone: phone_number ?? null })
    }
  }

  // Per-key 24h request counts; a failure here must not fail the list.
  let counts: Record<string, number> | null = null
  try {
    const rpcClient = supabase as unknown as {
      rpc(
        fn: string,
        args: Record<string, unknown>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ): PromiseLike<{ data: any; error: { message?: string; code?: string } | null }>
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: raw, error: countError } = await rpcClient.rpc("api_v2_key_request_counts", { p_since: since })
    if (countError) {
      console.error("[ADMIN API V2] Request counts error:", countError.code, countError.message)
    } else {
      counts = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, number>) : {}
    }
  } catch (e) {
    console.error("[ADMIN API V2] Request counts error:", e instanceof Error ? e.message : "unknown")
  }

  return NextResponse.json({
    keys: rows.map((k) => {
      const n = counts ? counts[k.id] : null
      return {
        ...k,
        owner: owners.get(k.user_id) ?? null,
        requests_24h: counts ? (typeof n === "number" ? n : 0) : null,
      }
    }),
  })
}
