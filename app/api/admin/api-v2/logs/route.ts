import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import { parseLogQuery } from "@/lib/api-v2/admin-stats"
import { escapeLike, chunk } from "@/lib/api-v2/admin-log-filter"

const LOG_COLUMNS =
  "id, key_id, user_id, method, endpoint, status_code, error_code, ip_address, duration_ms, environment, created_at"
const CHUNK = 200

type LogRow = { key_id: string | null; user_id: string | null } & Record<string, unknown>

/** GET /api/admin/api-v2/logs - Admin: paged request logs, newest first. */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const parsed = parseLogQuery(new URL(request.url).searchParams)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const q = parsed.value

  const supabase = getAdminClient()
  let query = supabase
    .from("api_v2_logs")
    .select(LOG_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    // Tie-breaker: rows with equal timestamps keep a stable order, so paging never repeats or skips one.
    .order("id", { ascending: false })
  if (q.keyId) query = query.eq("key_id", q.keyId)
  if (q.userId) query = query.eq("user_id", q.userId)
  if (q.statusClass === "success") query = query.gte("status_code", 200).lt("status_code", 400)
  else if (q.statusClass === "client_error") query = query.gte("status_code", 400).lt("status_code", 500)
  else if (q.statusClass === "server_error") query = query.gte("status_code", 500).lt("status_code", 600)
  if (q.since) query = query.gte("created_at", q.since)
  if (q.until) query = query.lte("created_at", q.until)
  if (q.endpoint) query = query.ilike("endpoint", `%${escapeLike(q.endpoint)}%`)
  query = query.range(q.offset, q.offset + q.limit - 1)

  const { data, error, count } = await query
  if (error) {
    console.error("[ADMIN API V2] Logs error:", error.code, error.message)
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 })
  }
  const rows = (data ?? []) as LogRow[]

  const keyIds = Array.from(new Set(rows.map((r) => r.key_id).filter((v): v is string => !!v)))
  const userIds = Array.from(new Set(rows.map((r) => r.user_id).filter((v): v is string => !!v)))

  const prefixes = new Map<string, string>()
  for (const ids of chunk(keyIds, CHUNK)) {
    const { data: keys, error: keysError } = await supabase.from("api_v2_keys").select("id, key_prefix").in("id", ids)
    if (keysError) {
      console.error("[ADMIN API V2] Logs key lookup error:", keysError.code, keysError.message)
      return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 })
    }
    for (const k of (keys ?? []) as Array<{ id: string; key_prefix: string }>) prefixes.set(k.id, k.key_prefix)
  }

  const emails = new Map<string, string | null>()
  for (const ids of chunk(userIds, CHUNK)) {
    const { data: users, error: usersError } = await supabase.from("users").select("id, email").in("id", ids)
    if (usersError) {
      console.error("[ADMIN API V2] Logs owner lookup error:", usersError.code, usersError.message)
      return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 })
    }
    for (const u of (users ?? []) as Array<{ id: string; email: string | null }>) emails.set(u.id, u.email ?? null)
  }

  return NextResponse.json({
    logs: rows.map((r) => ({
      ...r,
      key_prefix: (r.key_id && prefixes.get(r.key_id)) || null,
      owner_email: (r.user_id && emails.get(r.user_id)) || null,
    })),
    total: count ?? rows.length,
  })
}
