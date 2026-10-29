import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { countByLanding } from "@/lib/signup-source"

export const dynamic = "force-dynamic"

const WINDOW_DAYS = 30
const PAGE = 1000 // PostgREST caps a single response at 1000 rows
const MAX_ROWS = 5000

/** Admin-only: sign-ups of the last 30 days grouped by first landing page. */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const rows: Array<{ signup_source: unknown }> = []

  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from("users")
      .select("signup_source")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      console.error("[signup-sources] read failed:", error.code || "error")
      return NextResponse.json({ error: "Failed to load sign-up sources" }, { status: 500 })
    }
    const page = (data ?? []) as Array<{ signup_source: unknown }>
    rows.push(...page)
    if (page.length < PAGE) break
  }

  return NextResponse.json({
    since,
    total: rows.length,
    truncated: rows.length >= MAX_ROWS,
    rows: countByLanding(rows),
  })
}
