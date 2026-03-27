import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/admin/api-logs
 * Admin: Fetch programmatic API logs with optional filtering
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const userId = searchParams.get("userId")
  const apiKeyId = searchParams.get("apiKeyId")
  const statusCode = searchParams.get("statusCode")
  const limit = parseInt(searchParams.get("limit") || "100")
  const offset = parseInt(searchParams.get("offset") || "0")

  let query = supabase
    .from("user_api_logs")
    .select(`
      *,
      user:user_id (email, first_name),
      key:api_key_id (name, key_prefix)
    `)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (userId) query = query.eq("user_id", userId)
  if (apiKeyId) query = query.eq("api_key_id", apiKeyId)
  if (statusCode) query = query.eq("status_code", parseInt(statusCode))

  const { data: logs, error, count } = await query

  if (error) {
    console.error("[ADMIN API LOGS] Fetch error:", error)
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 })
  }

  return NextResponse.json({ logs, count })
}
