import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/admin/api-logs
 * Admin: Fetch programmatic API logs with optional filtering.
 * Uses a two-step fetch to avoid the broken auth.users join —
 * user_api_logs.user_id references auth.users which PostgREST cannot traverse.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const userId = searchParams.get("userId")
  const apiKeyId = searchParams.get("apiKeyId")
  const statusCode = searchParams.get("statusCode")
  const limit = parseInt(searchParams.get("limit") || "100")
  const offset = parseInt(searchParams.get("offset") || "0")

  // Step 1: Fetch logs without problematic joins
  let query = supabase
    .from("user_api_logs")
    .select("id, user_id, api_key_id, method, endpoint, status_code, ip_address, duration_ms, created_at")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (userId) query = query.eq("user_id", userId)
  if (apiKeyId) query = query.eq("api_key_id", apiKeyId)
  if (statusCode) query = query.eq("status_code", parseInt(statusCode))

  const { data: logs, error } = await query

  if (error) {
    console.error("[ADMIN API LOGS] Fetch error:", error)
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 })
  }

  if (!logs || logs.length === 0) {
    return NextResponse.json({ logs: [], count: 0 })
  }

  // Step 2: Fetch user details from public.users (not auth.users)
  const userIds = [...new Set(logs.map((l) => l.user_id).filter(Boolean))]
  const keyIds = [...new Set(logs.map((l) => l.api_key_id).filter(Boolean))]

  const [{ data: users }, { data: keys }] = await Promise.all([
    supabase
      .from("users")
      .select("id, email, first_name")
      .in("id", userIds),
    supabase
      .from("user_api_keys")
      .select("id, name, key_prefix")
      .in("id", keyIds),
  ])

  const userMap = (users || []).reduce((acc: any, u: any) => {
    acc[u.id] = u
    return acc
  }, {})

  const keyMap = (keys || []).reduce((acc: any, k: any) => {
    acc[k.id] = k
    return acc
  }, {})

  const enrichedLogs = logs.map((log) => ({
    ...log,
    user: userMap[log.user_id] || { email: "Unknown", first_name: "Unknown" },
    key: keyMap[log.api_key_id] || { name: "Unknown", key_prefix: "???" },
  }))

  return NextResponse.json({ logs: enrichedLogs, count: enrichedLogs.length })
}
