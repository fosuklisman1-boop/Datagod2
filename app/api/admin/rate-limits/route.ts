import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

/**
 * GET /api/admin/rate-limits
 * Returns recent rate limit blocks logged to the rate_limit_blocks table.
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { searchParams } = new URL(request.url)
  const limit = Math.min(parseInt(searchParams.get("limit") || "100") || 100, 500)
  const offset = Math.max(parseInt(searchParams.get("offset") || "0") || 0, 0)
  const endpoint = searchParams.get("endpoint") || ""
  const identifier = searchParams.get("identifier") || ""

  let query = supabase
    .from("rate_limit_blocks")
    .select("*", { count: "exact" })
    .order("blocked_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (endpoint) query = query.ilike("endpoint", `%${endpoint.slice(0, 100)}%`)
  if (identifier) query = query.ilike("identifier", `%${identifier.slice(0, 100)}%`)

  const { data, error, count } = await query

  if (error) {
    console.error("[ADMIN RATE-LIMITS] Fetch error:", error)
    return NextResponse.json({ error: "Failed to fetch rate limit blocks" }, { status: 500 })
  }

  return NextResponse.json({
    data: data || [],
    count: count || 0,
    pagination: { limit, offset, hasMore: (count || 0) > offset + limit },
  })
}
