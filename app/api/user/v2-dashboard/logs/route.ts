import type { NextRequest } from "next/server"
import { requireCapability } from "@/lib/roles/require-capability"
import { parseLogsQuery, readLogs } from "@/lib/api-v2/dev-dashboard"
import { dashboardClient, getSessionUser, json, readLimited, unauthorized } from "@/lib/api-v2/dashboard-session"

export const dynamic = "force-dynamic"

/** GET /api/user/v2-dashboard/logs - the caller's own v2 request log, newest first (see parseLogsQuery for filters). */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request)
  if (!user) return unauthorized()
  const refused = await requireCapability(dashboardClient(), user.id, "account.api")
  if (refused) return refused
  const limited = await readLimited(request, user.id, "v2_dashboard_read", 120, 60_000)
  if (limited) return limited
  const q = parseLogsQuery(request.nextUrl.searchParams)
  if (!q.ok) return json(400, { error: q.error, code: "bad_input" })
  const r = await readLogs(dashboardClient(), user.id, q.value)
  if (!r.ok) return json(503, { error: "Logs are temporarily unavailable.", code: "unavailable" })
  const rows = Array.isArray(r.value) ? (r.value as { id: string; created_at: string }[]) : []
  const last = rows.length === q.value.limit ? rows[rows.length - 1] : null
  return json(200, { rows, next: last ? `${last.created_at}|${last.id}` : null })
}
