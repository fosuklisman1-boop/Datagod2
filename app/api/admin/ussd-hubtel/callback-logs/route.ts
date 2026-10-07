import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { CALLBACK_LOG_TABLE, isCallbackLogTableMissing } from "@/lib/ussd-hubtel/callback-log"
import { safeDbError } from "@/lib/ussd-hubtel/log-safe"

/** Summary columns only: payload / raw_body / response / error / source_ip come from the detail route. */
export const CALLBACK_LOG_SUMMARY_COLUMNS = "id, created_at, direction, session_id, hubtel_order_id, outcome, ok, http_status"

const DIRECTIONS = ["inbound_fulfillment", "outbound_callback"] as const
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

const bad = (error: string) => NextResponse.json({ error }, { status: 400 })

// GET /api/admin/ussd-hubtel/callback-logs?direction=&problemsOnly=1&limit=50&before=<ISO>
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  // A rate-limited admin comes back with isAdmin true AND a 429 errorResponse: honour it.
  if (!isAdmin || errorResponse) return errorResponse ?? NextResponse.json({ error: "Admin access required" }, { status: 403 })

  const q = request.nextUrl.searchParams
  const limitRaw = q.get("limit")
  let limit = DEFAULT_LIMIT
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw)) return bad(`limit must be an integer from 1 to ${MAX_LIMIT}`)
    limit = Number(limitRaw)
    if (limit < 1 || limit > MAX_LIMIT) return bad(`limit must be an integer from 1 to ${MAX_LIMIT}`)
  }
  const direction = q.get("direction")
  if (direction !== null && !(DIRECTIONS as readonly string[]).includes(direction)) {
    return bad("direction must be inbound_fulfillment or outbound_callback")
  }
  const problemsRaw = q.get("problemsOnly")
  if (problemsRaw !== null && !["1", "0", "true", "false"].includes(problemsRaw)) return bad("problemsOnly must be 1 or 0")
  const problemsOnly = problemsRaw === "1" || problemsRaw === "true"
  const beforeRaw = q.get("before")
  let before: string | null = null
  if (beforeRaw !== null) {
    const t = Date.parse(beforeRaw)
    if (!/^\d{4}-\d{2}-\d{2}T/.test(beforeRaw) || !Number.isFinite(t)) return bad("before must be an ISO timestamp")
    before = new Date(t).toISOString()
  }

  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    let query = supabase.from(CALLBACK_LOG_TABLE).select(CALLBACK_LOG_SUMMARY_COLUMNS)
    if (direction) query = query.eq("direction", direction)
    if (problemsOnly) query = query.eq("ok", false)
    if (before) query = query.lt("created_at", before)
    // One extra row tells us whether another page exists.
    const { data, error } = await query.order("created_at", { ascending: false }).limit(limit + 1)
    if (error) {
      if (isCallbackLogTableMissing(error)) return NextResponse.json({ logs: [], tableMissing: true })
      console.error("[HUBTEL-ADMIN] callback-logs list error:", safeDbError(error))
      return NextResponse.json({ error: "Failed to load callback logs" }, { status: 500 })
    }
    const rows = (data ?? []) as Array<{ created_at: string }>
    const logs = rows.slice(0, limit)
    const nextBefore = rows.length > limit ? logs[logs.length - 1]?.created_at : undefined
    return NextResponse.json(nextBefore ? { logs, nextBefore } : { logs })
  } catch (e) {
    console.error("[HUBTEL-ADMIN] callback-logs list error:", safeDbError(e))
    return NextResponse.json({ error: "Failed to load callback logs" }, { status: 500 })
  }
}
