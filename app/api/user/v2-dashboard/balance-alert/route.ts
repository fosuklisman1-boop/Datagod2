import type { NextRequest } from "next/server"
import { requireCapability } from "@/lib/roles/require-capability"
import { getBalanceAlert, setBalanceAlert } from "@/lib/api-v2/dev-dashboard"
import { dashboardClient, getSessionUser, json, readLimited, unauthorized } from "@/lib/api-v2/dashboard-session"

export const dynamic = "force-dynamic"

/** GET /api/user/v2-dashboard/balance-alert - the caller's low-balance alert and wallet balance. */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request)
  if (!user) return unauthorized()
  const refused = await requireCapability(dashboardClient(), user.id, "account.api")
  if (refused) return refused
  const out = await getBalanceAlert(dashboardClient(), user.id)
  return json(out.status, out.body)
}

/** PUT /api/user/v2-dashboard/balance-alert - body { threshold: number | null }; null removes the alert. */
export async function PUT(request: NextRequest) {
  const user = await getSessionUser(request)
  if (!user) return unauthorized()
  const refused = await requireCapability(dashboardClient(), user.id, "account.api")
  if (refused) return refused
  const limited = await readLimited(request, user.id, "v2_dashboard_alert_write", 20, 60 * 60_000)
  if (limited) return limited
  const body = (await request.json().catch(() => null)) as { threshold?: unknown } | null
  if (!body || !("threshold" in body)) return json(400, { error: "Send { threshold }.", code: "bad_input" })
  const out = await setBalanceAlert(dashboardClient(), user.id, body.threshold)
  return json(out.status, out.body)
}
