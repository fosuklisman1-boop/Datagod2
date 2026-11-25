import { NextResponse, type NextRequest } from "next/server"
import { requireCapability } from "@/lib/roles/require-capability"
import { CSV_MAX_ROWS, ordersCsv, parseOrdersQuery, readOrders } from "@/lib/api-v2/dev-dashboard"
import { dashboardClient, getSessionUser, json, readLimited, unauthorized } from "@/lib/api-v2/dashboard-session"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/** GET /api/user/v2-dashboard/orders/csv - the same filters as the order list, as a CSV file (at most 5000 rows). */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request)
  if (!user) return unauthorized()
  const refused = await requireCapability(dashboardClient(), user.id, "account.api")
  if (refused) return refused
  const limited = await readLimited(request, user.id, "v2_dashboard_csv", 20, 60 * 60_000)
  if (limited) return limited
  const q = parseOrdersQuery(request.nextUrl.searchParams, { csv: true })
  if (!q.ok) return json(400, { error: q.error, code: "bad_input" })
  const r = await readOrders(dashboardClient(), user.id, q.value)
  if (!r.ok) return json(503, { error: "The download is temporarily unavailable.", code: "unavailable" })
  const rows = Array.isArray(r.value) ? r.value : []
  const day = new Date().toISOString().slice(0, 10)
  return new NextResponse(ordersCsv(rows), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="datagod-api-orders-${day}.csv"`,
      "Cache-Control": "no-store",
      "X-Row-Count": String(rows.length),
      "X-Row-Cap-Reached": rows.length >= CSV_MAX_ROWS ? "1" : "0",
    },
  })
}
