import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import { shapeStats } from "@/lib/api-v2/admin-stats"

const DAY_MS = 24 * 60 * 60 * 1000

/** GET /api/admin/api-v2/stats - Admin: 24h overview tiles. */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const supabase = getAdminClient() as unknown as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: { message?: string; code?: string } | null }>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any
  }

  const since = new Date(Date.now() - DAY_MS).toISOString()
  const { data: raw, error } = await supabase.rpc("api_v2_admin_stats", { p_since: since })
  if (error) {
    console.error("[ADMIN API V2] Stats error:", error.code, error.message)
    return NextResponse.json({ error: "Failed to load stats" }, { status: 500 })
  }

  let owner: { name: string | null; email: string | null } | null = null
  const topId = raw?.top?.user_id
  if (typeof topId === "string" && topId) {
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, first_name, last_name, email")
      .eq("id", topId)
      .maybeSingle()
    if (userError) {
      console.error("[ADMIN API V2] Stats owner lookup error:", userError.code, userError.message)
    } else if (user) {
      const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim()
      owner = { name: name || null, email: user.email ?? null }
    }
  }

  return NextResponse.json({ stats: shapeStats(raw, owner) })
}
