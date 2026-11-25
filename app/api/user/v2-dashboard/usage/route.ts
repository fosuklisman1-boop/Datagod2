import type { NextRequest } from "next/server"
import { requireCapability } from "@/lib/roles/require-capability"
import { readUsage } from "@/lib/api-v2/dev-dashboard"
import { dashboardClient, getSessionUser, json, readLimited, unauthorized } from "@/lib/api-v2/dashboard-session"

export const dynamic = "force-dynamic"

/** GET /api/user/v2-dashboard/usage?days=7|30&env=live|test - the caller's own API usage. */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request)
  if (!user) return unauthorized()
  const refused = await requireCapability(dashboardClient(), user.id, "account.api")
  if (refused) return refused
  const limited = await readLimited(request, user.id, "v2_dashboard_read", 120, 60_000)
  if (limited) return limited
  const p = request.nextUrl.searchParams
  const r = await readUsage(dashboardClient(), user.id, Number(p.get("days")), p.get("env"))
  return r.ok ? json(200, r.value) : json(503, { error: "Usage is temporarily unavailable.", code: "unavailable" })
}
