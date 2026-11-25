import type { NextRequest } from "next/server"
import { requireCapability } from "@/lib/roles/require-capability"
import { parseOrdersQuery, readOrders } from "@/lib/api-v2/dev-dashboard"
import { dashboardClient, getSessionUser, json, readLimited, unauthorized } from "@/lib/api-v2/dashboard-session"

export const dynamic = "force-dynamic"

/** GET /api/user/v2-dashboard/orders - the caller's own live API orders (see parseOrdersQuery for filters). */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request)
  if (!user) return unauthorized()
  const refused = await requireCapability(dashboardClient(), user.id, "account.api")
  if (refused) return refused
  const limited = await readLimited(request, user.id, "v2_dashboard_read", 120, 60_000)
  if (limited) return limited
  const q = parseOrdersQuery(request.nextUrl.searchParams)
  if (!q.ok) return json(400, { error: q.error, code: "bad_input" })
  const r = await readOrders(dashboardClient(), user.id, q.value)
  if (!r.ok) return json(503, { error: "Orders are temporarily unavailable.", code: "unavailable" })
  const rows = Array.isArray(r.value) ? r.value : []
  const last = rows.length === q.value.limit ? rows[rows.length - 1] : null
  return json(200, { rows, next: last ? `${last.created_at}|${last.product}:${last.reference}` : null })
}
